import { preparePublicCapture } from "./public-capture";
import type { ShaleSDK } from "@shale/sdk";
import type {
  BrowserIngestPayload,
  PageVisitPayload,
  PreparedPageData,
  TabsBatchPayload,
  IngestedPageResult,
} from "./types";
import type { BrowserExtensionSettings } from "./settings.types";
import { preparePageVisit, finalizePageVisit } from "./page-ingest";
import { processHistoryBatch, processBookmarksBatch } from "./catalog-ingest";
import { ingestSessionSnapshot } from "./session-manager";

export { preparePageVisit, finalizePageVisit } from "./page-ingest";
export { processHistoryBatch, processBookmarksBatch } from "./catalog-ingest";
export { chunkText } from "./chunk-text";

/**
 * Processes a single active web page visit through two-phase execution:
 * Phase 1: preparePageVisit (Chat model only, zero embeddings)
 * Phase 2: finalizePageVisit (Embedding model only, zero chat calls)
 */
export async function processPageVisit(
  sdk: ShaleSDK,
  payload: PageVisitPayload,
  settings: Partial<BrowserExtensionSettings>,
): Promise<IngestedPageResult | null> {
  return sdk.models.batch(
    () => preparePageVisit(sdk, payload, settings),
    (prepared) =>
      prepared
        ? finalizePageVisit(sdk, prepared, settings)
        : Promise.resolve(null),
  );
}

/**
 * Processes a batch of open tabs strictly enforcing the two-phase pipeline:
 * Phase 1: Prepares all tabs using Chat model (zero embeddings).
 * Phase 2: Embeds and commits all tabs using Embedding model (zero chat calls).
 */
export async function processTabsBatch(
  sdk: ShaleSDK,
  payload: TabsBatchPayload,
  settings: Partial<BrowserExtensionSettings>,
): Promise<{ ingestedCount: number; skippedCount: number }> {
  const pages = payload.pages || [];
  if (pages.length === 0) {
    return { ingestedCount: 0, skippedCount: 0 };
  }

  sdk.logger.info(
    `[browser] [Phase 1: Chat Model] Batch preparing ${pages.length} tab(s) with Chat model...`,
  );

  return sdk.models.batch(
    async () => {
      const preparedList: PreparedPageData[] = [];
      let skippedCount = 0;
      for (const page of pages) {
        const prepared = await preparePageVisit(sdk, page, settings);
        if (prepared) preparedList.push(prepared);
        else skippedCount++;
      }
      return { preparedList, skippedCount };
    },
    async ({ preparedList, skippedCount }) => {
      for (const prepared of preparedList)
        await finalizePageVisit(sdk, prepared, settings);
      return { ingestedCount: preparedList.length, skippedCount };
    },
  );
}

/**
 * Dispatches inbound browser payload to appropriate handler.
 */
export async function processBrowserPayload(
  sdk: ShaleSDK,
  payload: BrowserIngestPayload,
  settings: Partial<BrowserExtensionSettings>,
): Promise<any> {
  switch (payload.type) {
    case "page_visit":
    case "active_page":
      return processPageVisit(sdk, payload, settings);

    case "tabs_batch":
    case "pages_batch":
      return processTabsBatch(sdk, payload as TabsBatchPayload, settings);

    case "history_batch":
      return processHistoryBatch(sdk, payload, settings);

    case "bookmarks_batch":
      return processBookmarksBatch(sdk, payload, settings);

    case "session_snapshot":
    case "session_end":
      return ingestSessionSnapshot(sdk, payload, settings);

    case "public_page_capture":
      return sdk.models.batch(
        () => preparePublicCapture(sdk, payload, settings),
        async (prepared) =>
          prepared ? finalizePageVisit(sdk, prepared, settings) : null,
      );
    case "activity_event":
    case "catalog_delete":
    case "browser_batch":
    case "ping":
      return { pong: true };

    default:
      sdk.logger.warn(
        `Unrecognized browser payload type: ${(payload as any)?.type}`,
      );
      return null;
  }
}
