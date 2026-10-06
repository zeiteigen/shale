import type { ShaleSDK } from "@shale/sdk";
import type {
  BrowserIngestPayload,
  BrowserRecord,
  BrowserReceipt,
} from "../../lib/browser-contract";
import {
  validateBrowserPayload,
  BrowserProtocolError,
} from "../../lib/browser-validation";
import { migrateLegacyInbox, putJob } from "./inbox-store";
import { storeActivity } from "./activity-store";
import { browserSettings } from "./settings-policy";
import { evaluateUrl } from "./filter";
import type { BrowserExtensionSettings } from "./settings.types";

/** Validation and SQLite admission only. No model requests or in-memory acknowledgement. */
export function admitBrowserPayload(
  sdk: ShaleSDK,
  value: unknown,
): BrowserReceipt {
  validateBrowserPayload(value);
  migrateLegacyInbox(sdk);
  const versioned = value.type === "browser_batch";
  const collectorId = versioned ? value.collectorId : "legacy";
  const batchId = versioned ? value.batchId : crypto.randomUUID();
  const records: Array<BrowserIngestPayload | BrowserRecord> = versioned
    ? value.records
    : value.type === "tabs_batch" || value.type === "pages_batch"
      ? value.pages
      : value.type === "history_batch"
        ? value.items.map((x) => ({ ...x, type: "history_item" as const }))
        : value.type === "bookmarks_batch"
          ? value.items.map((x) => ({ ...x, type: "bookmark_item" as const }))
          : [value];
  const settings = browserSettings(sdk);
  return sdk.database.transaction(() => {
    const receipts: BrowserReceipt["records"] = [];
    for (const record of records) {
      const recordId =
        ("recordId" in record && record.recordId) || crypto.randomUUID();
      let skip: string | undefined;
      if (
        record.type === "public_page_capture" &&
        settings.allowPublicPageEnrichment !== true
      )
        skip = "Public-page enrichment is disabled";
      if (
        "incognito" in record &&
        record.incognito &&
        settings.excludePrivateBrowsing !== false
      )
        skip = "Private browsing excluded";
      if ("url" in record && record.url) {
        const check = evaluateUrl(record.url, settings);
        if (!check.allowed) skip = check.reason;
      }
      const existing = sdk.database
        .query(
          "SELECT 1 FROM browser_jobs WHERE extension_id=? AND collector_id=? AND record_id=?",
        )
        .get(sdk.extensionId, collectorId, recordId);
      if (!existing && !skip) {
        const size = sdk.database
          .query<{ count: number; bytes: number }, [string]>(
            `SELECT count(*) AS count,coalesce(sum(payload_bytes),0) AS bytes
          FROM browser_jobs WHERE extension_id=? AND state IN ('received','prepared','failed')`,
          )
          .get(sdk.extensionId)!;
        if (
          size.count >= (settings.maxPendingJobs ?? 5000) ||
          size.bytes + new TextEncoder().encode(JSON.stringify(record)).length >
            (settings.maxPendingBytes ?? 50000000)
        )
          throw new BrowserProtocolError(
            "Browser inbox is full; retry after processing catches up",
            429,
          );
      }
      let payload: BrowserIngestPayload = record as BrowserIngestPayload;
      if (record.type === "history_item")
        payload = {
          type: "history_batch",
          items: [
            { ...record, collectorId, title: record.title || record.url },
          ],
        };
      if (record.type === "bookmark_item")
        payload = {
          type: "bookmarks_batch",
          items: [
            { ...record, collectorId, title: record.title || record.url! },
          ],
        };
      const receipt = putJob(
        sdk,
        collectorId,
        recordId,
        batchId,
        payload,
        Date.now(),
        skip,
      );
      receipts.push(receipt);
      if (
        receipt.status === "received" &&
        (record.type === "activity_event" ||
          record.type === "page_visit" ||
          record.type === "active_page")
      )
        storeActivity(sdk, collectorId, recordId, record);
    }
    return {
      protocolVersion: 1 as const,
      collectorId,
      batchId,
      records: receipts,
    };
  })();
}
