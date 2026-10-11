import { storeActivity } from "./activity-store";
import type { ShaleSDK } from "@shale/sdk";
import { createHash } from "node:crypto";
import type { BrowserIngestPayload } from "./types";
import type { BrowserRecord } from "../../lib/browser-contract";
import { BrowserProtocolError } from "../../lib/browser-validation";
import { ensureBrowserSchema } from "./storage-schema";

export function fingerprint(value: unknown): string {
  const stable = (v: any): any =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .filter((k) => v[k] !== undefined)
              .map((k) => [k, stable(v[k])]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}
export interface BrowserJob {
  id: string;
  receivedAt: number;
  payload: BrowserIngestPayload;
  collectorId: string;
  state: string;
  attempts: number;
  prepared?: import("./payload-pipeline").PreparedBrowserPayload;
  settings?: Partial<import("./settings.types").BrowserExtensionSettings>;
}
export function migrateLegacyInbox(sdk: ShaleSDK): void {
  ensureBrowserSchema(sdk.database);
  const old =
    sdk.state.getJson<
      Array<{ id: string; receivedAt: number; payload: BrowserIngestPayload }>
    >("pending-ingest");
  const active = sdk.state.getJson<import("./types").ActiveSessionState>(
    "active_session_state",
  );
  if (!old && !active) return;
  sdk.database.transaction(() => {
    for (const item of old ?? [])
      putJob(sdk, "legacy", item.id, item.id, item.payload, item.receivedAt);
    for (const [index, visit] of (active?.visits ?? []).entries()) {
      const recordId = `legacy-active:${fingerprint([active!.sessionId, index, visit])}`;
      const event = {
        ...visit,
        type: "activity_event" as const,
        kind: "navigation" as const,
        recordId,
        eventId: visit.eventId || recordId,
        collectorId: visit.collectorId ?? "legacy",
        sessionId: active!.sessionId,
        title: visit.title || visit.url,
      };
      const receipt = putJob(
        sdk,
        event.collectorId,
        recordId,
        "legacy-active-session",
        event,
        visit.visitedAt,
      );
      if (receipt.status === "received")
        storeActivity(sdk, event.collectorId, recordId, event);
    }
    if (active) sdk.state.delete("active_session_state");
    sdk.state.delete("pending-ingest");
  })();
}
export function putJob(
  sdk: ShaleSDK,
  collectorId: string,
  recordId: string,
  batchId: string,
  payload: BrowserIngestPayload | BrowserRecord,
  receivedAt = Date.now(),
  skipReason?: string,
) {
  const hash = fingerprint(payload);
  const old = sdk.database
    .query<
      { id: string; payload_hash: string; state: string; error: string | null },
      [string, string, string]
    >(
      "SELECT id,payload_hash,state,error FROM browser_jobs WHERE extension_id=? AND collector_id=? AND record_id=?",
    )
    .get(sdk.extensionId, collectorId, recordId);
  if (old) {
    if (old.payload_hash !== hash)
      throw new BrowserProtocolError(
        `Record ID ${recordId} was reused with different content`,
        409,
      );
    return {
      recordId,
      jobId: old.id,
      status: "duplicate" as const,
      reason: old.error ?? undefined,
    };
  }
  const id = `browser-job:${fingerprint([sdk.extensionId, collectorId, recordId])}`;
  const normalized =
    payload.type === "page_visit" || payload.type === "active_page"
      ? {
          ...payload,
          title: payload.title || payload.url,
          collectorId,
          recordId,
        }
      : { ...payload, collectorId, recordId };
  const serialized = JSON.stringify(skipReason ? { type: "ping" } : normalized);
  sdk.database
    .query(
      `INSERT INTO browser_jobs(id,extension_id,collector_id,record_id,batch_id,payload_hash,payload,
    received_at,updated_at,state,error,payload_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      sdk.extensionId,
      collectorId,
      recordId,
      batchId,
      hash,
      serialized,
      receivedAt,
      Date.now(),
      skipReason ? "skipped" : "received",
      skipReason ?? null,
      new TextEncoder().encode(serialized).length,
    );
  return {
    recordId,
    jobId: id,
    status: skipReason ? ("skipped" as const) : ("received" as const),
    reason: skipReason,
  };
}
export function pendingJobs(
  sdk: ShaleSDK,
  limit = 100,
  due = true,
): BrowserJob[] {
  migrateLegacyInbox(sdk);
  expireStaleRawJobs(sdk);
  sdk.database.query(`DELETE FROM browser_content_cache WHERE extension_id=? AND updated_at<?
    AND coalesce(json_extract(prepared,'$.cacheState'),'staged')!='complete'`)
    .run(sdk.extensionId, Date.now() - 24 * 60 * 60 * 1000);
  const rows = sdk.database
    .query<any, [string, number, number]>(
      `SELECT * FROM browser_jobs WHERE extension_id=?
    AND state IN ('received','prepared') AND next_attempt_at<=? ORDER BY received_at,coalesce(json_extract(payload,'$.sequence'),0),id LIMIT ?`,
    )
    .all(sdk.extensionId, due ? Date.now() : Number.MAX_SAFE_INTEGER, limit);
  return rows.map((row) => ({
    id: row.id,
    receivedAt: row.received_at,
    collectorId: row.collector_id,
    payload: JSON.parse(row.payload),
    state: row.state,
    attempts: row.attempts,
    prepared: row.prepared ? JSON.parse(row.prepared) : undefined,
    settings: row.settings ? JSON.parse(row.settings) : undefined,
  }));
}
/** Failed transport records keep enough time for retry, then become receipts. */
export function expireStaleRawJobs(sdk: ShaleSDK, now = Date.now()) {
  const cutoff = now - 24 * 60 * 60 * 1000;
  const expired = sdk.database
    .query<{ id: string; state: string; prepared: string | null }, [string, number]>(
      `SELECT id,state,prepared FROM browser_jobs WHERE extension_id=?
       AND state IN ('received','prepared','failed') AND received_at<? AND payload_bytes>0`,
    )
    .all(sdk.extensionId, cutoff);
  if (!expired.length) return 0;
  sdk.database.transaction(() => {
    for (const row of expired) {
      const keepPrepared = isBoundedPrepared(row.prepared);
      sdk.database
        .query(
          `UPDATE browser_jobs SET state=CASE WHEN ? AND state!='failed' THEN 'prepared' WHEN ? THEN state ELSE 'failed' END,
          payload=json_object('type',json_extract(payload,'$.type'),'recordId',record_id,'collectorId',collector_id,'url',json_extract(payload,'$.url')),
          payload_bytes=0,settings=NULL,
          prepared=CASE WHEN ? THEN prepared ELSE NULL END,
          error=CASE WHEN ? THEN 'Raw capture expired after 24 hours; prepared memory retained' ELSE 'Raw capture expired after 24 hours; resubmit to retry' END,
          outcome=CASE WHEN ? THEN '{"rawExpired":true,"preparedRetained":true}' ELSE '{"expired":true}' END,updated_at=?
          WHERE extension_id=? AND id=?`,
        )
        .run(keepPrepared, keepPrepared, keepPrepared, keepPrepared, keepPrepared, now, sdk.extensionId, row.id);
      if (!keepPrepared) sdk.checkpoint.delete(row.id);
    }
  })();
  return expired.length;
}
function isBoundedPrepared(value: string | null): boolean {
  if (!value || value.length > 256_000) return false;
  try {
    const data = JSON.parse(value);
    const pages = data?.type === "pages" ? data.pages : data?.prepared?.type === "pages" ? data.prepared.pages : null;
    if (Array.isArray(pages)) return pages.every((page: any) => !!page?.memory?.summary &&
      Array.isArray(page.memory.snippets) && page.memory.snippets.length <= 16 &&
      page.memory.snippets.every((snippet: any) => typeof snippet.text === "string" && snippet.text.length <= 1200));
    return data?.type === "session" || data?.prepared?.type === "session" ||
      data?.type === "history" || data?.prepared?.type === "history" ||
      data?.type === "bookmarks" || data?.prepared?.type === "bookmarks";
  } catch { return false; }
}
export function finishJob(sdk: ShaleSDK, id: string, outcome: unknown = {}) {
  sdk.database
    .query(
      `UPDATE browser_jobs SET state='indexed',updated_at=?,prepared=NULL,settings=NULL,error=NULL,outcome=?,
    payload=json_object('type',json_extract(payload,'$.type'),'recordId',record_id,'collectorId',collector_id,'url',json_extract(payload,'$.url')),payload_bytes=0 WHERE id=? AND extension_id=? AND state IN ('received','prepared')`,
    )
    .run(Date.now(), JSON.stringify(outcome), id, sdk.extensionId);
  sdk.checkpoint.delete(id);
}
export function prepareJob(
  sdk: ShaleSDK,
  job: BrowserJob,
  prepared: import("./payload-pipeline").PreparedBrowserPayload,
) {
  sdk.database.transaction(() => {
    sdk.checkpoint.save(
      { type: "browser_job", jobId: job.id, prepared },
      { id: job.id, key: job.id },
    );
    sdk.database
      .query(
        `UPDATE browser_jobs SET prepared=?,settings=NULL,state='prepared',updated_at=?,
         payload=json_object('type',json_extract(payload,'$.type'),'recordId',record_id,'collectorId',collector_id,'url',json_extract(payload,'$.url')),
         payload_bytes=0 WHERE id=? AND extension_id=?`,
      )
      .run(
        JSON.stringify(prepared),
        Date.now(),
        job.id,
        sdk.extensionId,
      );
  })();
}
export function failJob(
  sdk: ShaleSDK,
  job: Pick<BrowserJob, "id" | "attempts">,
  error: unknown,
  maxAttempts = 5,
) {
  sdk.database.transaction(() => {
    const attempts = job.attempts + 1;
    if (attempts >= maxAttempts)
      sdk.database
        .query(
          "UPDATE checkpoints SET status='failed' WHERE extension_id=? AND id=?",
        )
        .run(sdk.extensionId, job.id);
    sdk.database
      .query(
        `UPDATE browser_jobs SET attempts=?,next_attempt_at=?,error=?,state=CASE WHEN ?>=? THEN 'failed' ELSE state END,
    updated_at=? WHERE id=? AND extension_id=? AND state IN ('received','prepared')`,
      )
      .run(
        attempts,
        Date.now() + Math.min(3600000, 1000 * 2 ** attempts),
        String(error).slice(0, 2000),
        attempts,
        maxAttempts,
        Date.now(),
        job.id,
        sdk.extensionId,
      );
  })();
}
