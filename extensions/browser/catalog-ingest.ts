import type { ShaleSDK } from "@shale/sdk";
import type { HistoryBatchPayload, BookmarksBatchPayload } from "./types";
import type { BrowserExtensionSettings } from "./settings.types";
import { evaluateUrl } from "./filter";
import { bookmarkSourceUri, browserSourceId, historySourceUri, pageEntityName } from "./identity";
import { commitCatalogGraph } from "./catalog-graph";

/**
 * Processes a batch of browser history visits.
 */
export async function processHistoryBatch(
  sdk: ShaleSDK,
  payload: HistoryBatchPayload,
  settings: Partial<BrowserExtensionSettings>,
): Promise<{ ingestedCount: number; skippedCount: number }> {
  const namespace = settings.namespace || sdk.namespace || "browser";
  let skippedCount = 0;

  const validItems: Array<{
    title: string;
    filter: ReturnType<typeof evaluateUrl>;
    visitTime: number;
    visitCount?: number;
    typedCount?: number;
    textContent: string;
    sourceId: string;
    sourceUri: string;
    pageEntity: string;
  }> = [];

  for (const item of payload.items) {
    const filter = evaluateUrl(item.url, settings);
    if (!filter.allowed) {
      skippedCount++;
      continue;
    }

    const title = (item.title || filter.domain || "Historical Page").trim();
    const visitTime = item.visitTime || Date.now();
    const textContent = `Page: ${title}\nDomain: ${filter.domain}\nURL: ${filter.cleanUrl}\nVisited: ${new Date(
      visitTime,
    ).toISOString()}${item.visitCount !== undefined ? `\nVisit Count: ${item.visitCount}` : ""}${item.typedCount !== undefined ? `\nTyped Count: ${item.typedCount}` : ""}`;
    const sourceId = browserSourceId("history", filter.cleanUrl);

    validItems.push({
      title,
      filter,
      visitTime,
      visitCount: item.visitCount,
      typedCount: item.typedCount,
      textContent,
      sourceId,
      sourceUri: historySourceUri(filter.cleanUrl),
      pageEntity: pageEntityName(filter.cleanUrl),
    });
  }

  if (validItems.length === 0) {
    sdk.logger.info(
      `[History] 0 valid items in batch (${skippedCount} excluded/skipped).`,
    );
    return { ingestedCount: 0, skippedCount };
  }

  sdk.logger.info(
    `[History] Ingesting batch of ${validItems.length} items (${skippedCount} excluded/skipped)...`,
  );

  // Batch embed all items simultaneously
  const texts = validItems.map((v) => v.textContent);
  const embeddings = await sdk.embed(texts);

  sdk.database.transaction(() => {
    for (let i = 0; i < validItems.length; i++) {
      const v = validItems[i];
      sdk.ingest.sourceAndChunks({
        source: {
          id: v.sourceId,
          type: "browser_history",
          uri: v.sourceUri,
          origin: "browser",
          title: v.title,
          created_at: v.visitTime,
          updated_at: v.visitTime,
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
  
      commitCatalogGraph(sdk,v,namespace);
    }
  })();

  return { ingestedCount: validItems.length, skippedCount };
}

/**
 * Processes a batch of browser bookmarks.
 */
export async function processBookmarksBatch(
  sdk: ShaleSDK,
  payload: BookmarksBatchPayload,
  settings: Partial<BrowserExtensionSettings>,
): Promise<{ ingestedCount: number; skippedCount: number }> {
  const namespace = settings.namespace || sdk.namespace || "browser";
  let skippedCount = 0;

  const validItems: Array<{
    title: string;
    folder: string;
    filter: ReturnType<typeof evaluateUrl>;
    dateAdded: number;
    textContent: string;
    sourceId: string;
    sourceUri: string;
    pageEntity: string;
  }> = [];

  for (const item of payload.items) {
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
    const textContent = `Bookmark: ${title}\nFolder: ${folder}\nDomain: ${filter.domain}\nURL: ${filter.cleanUrl}\nAdded At: ${dateAdded}`;
    const sourceUri = bookmarkSourceUri(item.id, filter.cleanUrl);
    const sourceId = browserSourceId("bookmark", sourceUri);

    validItems.push({
      title,
      folder,
      filter,
      dateAdded,
      textContent,
      sourceId,
      sourceUri,
      pageEntity: pageEntityName(filter.cleanUrl),
    });
  }

  if (validItems.length === 0) {
    sdk.logger.info(
      `[Bookmarks] 0 valid items in batch (${skippedCount} excluded/skipped).`,
    );
    return { ingestedCount: 0, skippedCount };
  }

  sdk.logger.info(
    `[Bookmarks] Ingesting batch of ${validItems.length} bookmarks (${skippedCount} excluded/skipped)...`,
  );

  // Batch embed all items simultaneously
  const texts = validItems.map((v) => v.textContent);
  const embeddings = await sdk.embed(texts);

  sdk.database.transaction(() => {
    for (let i = 0; i < validItems.length; i++) {
      const v = validItems[i];
      sdk.ingest.sourceAndChunks({
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
  
      commitCatalogGraph(sdk,v,namespace);
    }
  })();

  return { ingestedCount: validItems.length, skippedCount };
}

