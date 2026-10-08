import { embedBounded } from "./embed-bounded";
import { ensureBrowserSchema } from "./storage-schema";
import { recordCatalog, isCatalogStale } from "./catalog-lifecycle";
import type { ShaleSDK } from "@shale/sdk";
import type { BookmarksBatchPayload } from "./types";
import type { BrowserExtensionSettings } from "./settings.types";
import { evaluateUrl } from "./filter";
import {
  bookmarkSourceUri,
  browserSourceId,
  pageEntityName,
} from "./identity";
import { commitCatalogGraph } from "./catalog-graph";
import { isSourceExcluded } from "../../lib/knowledge/exclusions";

export { processHistoryBatch } from "./history-ingest";

/**
 * Processes a batch of browser bookmarks.
 */
export async function processBookmarksBatch(
  sdk: ShaleSDK,
  payload: BookmarksBatchPayload,
  settings: Partial<BrowserExtensionSettings>,
  afterCommit: () => void = () => {},
): Promise<{ ingestedCount: number; skippedCount: number }> {
  ensureBrowserSchema(sdk.database);
  const namespace = settings.namespace || sdk.namespace || "browser";
  let skippedCount = 0;
  let ingestedCount = 0;

  const validItems: Array<{
    title: string;
    folder: string;
    filter: ReturnType<typeof evaluateUrl>;
    dateAdded: number;
    textContent: string;
    sourceId: string;
    sourceUri: string;
    pageEntity: string;
    original?: (typeof payload.items)[number];
  }> = [];

  for (const item of payload.items) {
    if (isCatalogStale(sdk, "bookmark", item)) {
      skippedCount++;
      continue;
    }
    if (!item.url) {
      skippedCount++;
      continue;
    }

    const filter = evaluateUrl(item.url, settings);
    if (!filter.allowed) {
      skippedCount++;
      continue;
    }

    const title = (item.title || filter.domain || "Bookmark").trim();
    const folder = (item.folderPath || "Bookmarks Bar").trim();
    const dateAdded = item.dateAdded || Date.now();
    const textContent = `Bookmark: ${title}${item.sequence !== undefined ? `\nObservation sequence: ${item.sequence}` : ""}\nFolder: ${folder}\nDomain: ${filter.domain}\nURL: ${filter.cleanUrl}\nAdded At: ${dateAdded}`;
    const sourceUri = item.collectorId
      ? `browser-bookmark://${encodeURIComponent(item.collectorId)}/${encodeURIComponent(item.id)}`
      : bookmarkSourceUri(item.id, filter.cleanUrl);
    const sourceId = browserSourceId("bookmark", sourceUri);
    if (isSourceExcluded(sdk.database, sourceId, sourceUri) || isSourceExcluded(sdk.database,undefined,filter.cleanUrl)) {
      skippedCount++;
      continue;
    }

    validItems.push({
      title,
      folder,
      filter,
      dateAdded,
      textContent,
      sourceId,
      sourceUri,
      pageEntity: pageEntityName(filter.cleanUrl),
      original: item,
    });
  }

  if (validItems.length === 0) {
    sdk.logger.info(
      `[Bookmarks] 0 valid items in batch (${skippedCount} excluded/skipped).`,
    );
    sdk.database.transaction(afterCommit)();
    return { ingestedCount: 0, skippedCount };
  }

  sdk.logger.info(
    `[Bookmarks] Ingesting batch of ${validItems.length} bookmarks (${skippedCount} excluded/skipped)...`,
  );

  // Batch embed all items simultaneously
  const texts = validItems.map((v) => v.textContent);
  const embeddings = await embedBounded(sdk, texts, settings);

  sdk.database.transaction(() => {
    for (let i = 0; i < validItems.length; i++) {
      const v = validItems[i];
      if(isSourceExcluded(sdk.database,undefined,v.filter.cleanUrl)) {skippedCount++;continue;}
      const result = sdk.ingest.sourceAndChunks({
        source: {
          id: v.sourceId,
          type: "bookmark",
          uri: v.sourceUri,
          origin: "browser",
          title: v.title,
          created_at: v.dateAdded,
          updated_at: v.dateAdded,
        },
        chunks: [
          {
            chunk_index: 0,
            chunk_type: "verbatim",
            text_content: v.textContent,
            embedding: embeddings[i],
          },
        ],
        namespace,
      });

      if (result.skipped) {
        skippedCount++;
        continue;
      }

      commitCatalogGraph(sdk, v, namespace);
      recordCatalog(sdk, "bookmark", v.original, v.sourceId);
      ingestedCount++;
    }
    afterCommit();
  })();

  return { ingestedCount, skippedCount };
}
