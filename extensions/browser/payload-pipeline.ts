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
  processHistoryBatch,
  processBookmarksBatch,
} from "./ingest-processor";
import { prepareSessionSnapshot, finalizeSession } from "./session-manager";

export type PreparedBrowserPayload =
  | { type: "pages"; pages: PreparedPageData[] }
  | { type: "session"; session: PreparedSessionData | null }
  | { type: "history"; payload: HistoryBatchPayload }
  | { type: "bookmarks"; payload: BookmarksBatchPayload }
  | { type: "ping" };

export async function prepareBrowserPayload(
  sdk: ShaleSDK,
  payload: BrowserIngestPayload,
  settings: Partial<BrowserExtensionSettings>,
): Promise<PreparedBrowserPayload> {
  switch (payload.type) {
    case "page_visit":
    case "active_page": {
      const page = await preparePageVisit(sdk, payload, settings);
      return { type: "pages", pages: page ? [page] : [] };
    }
    case "tabs_batch":
    case "pages_batch": {
      const pages: PreparedPageData[] = [];
      for (const page of payload.pages ?? []) {
        const prepared = await preparePageVisit(sdk, page, settings);
        if (prepared) pages.push(prepared);
      }
      return { type: "pages", pages };
    }
    case "session_snapshot":
    case "session_end":
      return {
        type: "session",
        session: await prepareSessionSnapshot(sdk, payload, settings),
      };
    case "history_batch":
      return { type: "history", payload };
    case "bookmarks_batch":
      return { type: "bookmarks", payload };
    case "ping":
      return { type: "ping" };
  }
}

export async function finalizeBrowserPayload(
  sdk: ShaleSDK,
  prepared: PreparedBrowserPayload,
  settings: Partial<BrowserExtensionSettings>,
): Promise<void> {
  switch (prepared.type) {
    case "pages":
      for (const page of prepared.pages)
        await finalizePageVisit(sdk, page, settings);
      break;
    case "session":
      if (prepared.session)
        await finalizeSession(sdk, prepared.session, settings);
      break;
    case "history":
      await processHistoryBatch(sdk, prepared.payload, settings);
      break;
    case "bookmarks":
      await processBookmarksBatch(sdk, prepared.payload, settings);
      break;
  }
}
