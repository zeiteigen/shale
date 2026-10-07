import { preparePublicCapture } from "./public-capture";
import { prepareHistoryContent, type HistoryPageContent } from "./history-content";
import { finalizeHistoryBatch } from "./history-ingest";
import { finalizeActivity } from "./activity-graph";
import { applyCatalogDeletion } from "./catalog-lifecycle";
import type { ShaleSDK } from "@shale/sdk";
import type { BrowserExtensionSettings } from "./settings.types";
import type {
  BrowserIngestPayload,
  HistoryBatchPayload,
  BookmarksBatchPayload,
  PreparedPageData,
  PreparedSessionData,
} from "./types";
import {
  preparePageVisit,
  finalizePageVisit,
  processBookmarksBatch,
} from "./ingest-processor";
import { prepareSessionSnapshot, finalizeSession } from "./session-manager";

export type PreparedBrowserPayload =
  | { type: "pages"; pages: PreparedPageData[] }
  | { type: "session"; session: PreparedSessionData | null }
  | { type: "history"; payload: HistoryBatchPayload; contents?: Array<HistoryPageContent | null> }
  | { type: "bookmarks"; payload: BookmarksBatchPayload }
  | { type: "ping" }
  | {
      type: "activity";
      payload: import("../../lib/browser-contract").ActivityEventPayload;
    }
  | {
      type: "delete";
      payload: import("../../lib/browser-contract").CatalogDeletePayload;
    };

export async function prepareBrowserPayload(
  sdk: ShaleSDK,
  payload: BrowserIngestPayload,
  settings: Partial<BrowserExtensionSettings>,
  options: { jobId?: string; managed?: boolean } = {},
): Promise<PreparedBrowserPayload> {
  switch (payload.type) {
    case "public_page_capture": {
      const page = await preparePublicCapture(sdk, payload, settings, options);
      return { type: "pages", pages: page ? [page] : [] };
    }
    case "page_visit":
    case "active_page": {
      const page = await preparePageVisit(sdk, payload, settings, options);
      return { type: "pages", pages: page ? [page] : [] };
    }
    case "tabs_batch":
    case "pages_batch": {
      const pages = (await sdk.models.mapChat(payload.pages ?? [], (page, index) =>
        preparePageVisit(sdk, page, settings, {
          ...options,
          jobId: options.jobId ? `${options.jobId}:${index}` : undefined,
        }))).filter((page): page is PreparedPageData => !!page);
      return { type: "pages", pages };
    }
    case "session_snapshot":
    case "session_end":
      return {
        type: "session",
        session: await prepareSessionSnapshot(sdk, payload, settings),
      };
    case "history_batch":
      return { type: "history", payload, contents: await prepareHistoryContent(sdk, payload, settings) };
    case "bookmarks_batch":
      return { type: "bookmarks", payload };
    case "activity_event":
      return { type: "activity", payload };
    case "ping":
      return { type: "ping" };
    case "catalog_delete":
      return { type: "delete", payload };
    case "browser_batch":
      throw new Error("Versioned batches must be split at admission");
  }
}

export async function finalizeBrowserPayload(
  sdk: ShaleSDK,
  prepared: PreparedBrowserPayload,
  settings: Partial<BrowserExtensionSettings>,
  assertOwned: () => void = () => {},
  afterCommit: () => void = () => {},
): Promise<void> {
  switch (prepared.type) {
    case "pages":
      for (const page of prepared.pages)
        await finalizePageVisit(sdk, page, settings, assertOwned);
      break;
    case "session":
      if (prepared.session)
        await finalizeSession(sdk, prepared.session, settings, assertOwned);
      break;
    case "activity":
      await finalizeActivity(
        sdk,
        prepared.payload,
        settings,
        assertOwned,
        afterCommit,
      );
      break;
    case "history":
      await finalizeHistoryBatch(sdk, prepared.payload, settings, () => {
        assertOwned();
        afterCommit();
      }, prepared.contents);
      break;
    case "delete":
      sdk.database.transaction(() => {
        assertOwned();
        applyCatalogDeletion(sdk, prepared.payload);
        afterCommit();
      })();
      break;
    case "bookmarks":
      await processBookmarksBatch(sdk, prepared.payload, settings, () => {
        assertOwned();
        afterCommit();
      });
      break;
  }
}
