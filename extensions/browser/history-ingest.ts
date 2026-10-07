import { embedBounded } from "./embed-bounded";
import { ensureBrowserSchema } from "./storage-schema";
import { recordCatalog, isCatalogStale } from "./catalog-lifecycle";
import type { ShaleSDK } from "@shale/sdk";
import type { HistoryBatchPayload } from "./types";
import type { BrowserExtensionSettings } from "./settings.types";
import { evaluateUrl } from "./filter";
import {
  browserSourceId,
  historySourceUri,
  pageEntityName,
} from "./identity";
import { commitCatalogGraph } from "./catalog-graph";

import { prepareHistoryContent, type HistoryPageContent } from "./history-content";

/**
 * Processes a batch of browser history visits.
 */
export async function finalizeHistoryBatch(
  sdk: ShaleSDK,
  payload: HistoryBatchPayload,
  settings: Partial<BrowserExtensionSettings>,
  afterCommit: () => void = () => {},
  contents: Array<HistoryPageContent | null> = [],
): Promise<{ ingestedCount: number; skippedCount: number }> {
  ensureBrowserSchema(sdk.database);
  const namespace = settings.namespace || sdk.namespace || "browser";
  let skippedCount = 0;

  const validItems: Array<{
    title: string;
    filter: ReturnType<typeof evaluateUrl>;
    visitTime: number;
    visitCount?: number;
    typedCount?: number;
    textContent: string;
    chunks: string[];
    sourceId: string;
    sourceUri: string;
    pageEntity: string;
    original?: (typeof payload.items)[number];
  }> = [];

  for (const [index, item] of payload.items.entries()) {
    if (isCatalogStale(sdk, "history", item)) {
      skippedCount++;
      continue;
    }
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
    const sourceUri = item.collectorId
      ? `browser-history://${encodeURIComponent(item.collectorId)}/${encodeURIComponent(item.id || filter.cleanUrl)}`
      : historySourceUri(filter.cleanUrl);
    const sourceId = browserSourceId("history", sourceUri);

    const content = contents[index];
    const fetched = content?.url === filter.cleanUrl ? content : null;
    const chunks = [
      textContent + (fetched
        ? `\nContent Origin: public-fetch\nContent Fetched At: ${new Date(fetched.fetchedAt).toISOString()}\nExtraction: ${JSON.stringify(fetched.extraction ?? {})}`
        : ""),
      ...(fetched?.chunks ?? []),
    ];
    validItems.push({
      title,
      filter,
      visitTime,
      visitCount: item.visitCount,
      typedCount: item.typedCount,
      textContent,
      chunks,
      sourceId,
      sourceUri,
      pageEntity: pageEntityName(filter.cleanUrl),
      original: item,
    });
  }

  if (validItems.length === 0) {
    sdk.logger.info(
      `[History] 0 valid items in batch (${skippedCount} excluded/skipped).`,
    );
    sdk.database.transaction(afterCommit)();
    return { ingestedCount: 0, skippedCount };
  }

  sdk.logger.info(
    `[History] Ingesting batch of ${validItems.length} items (${skippedCount} excluded/skipped)...`,
  );

  // All page fetches and parsing finished in preparation.
  const texts = validItems.flatMap((v) => v.chunks);
  const embeddings = await embedBounded(sdk, texts, settings);

  sdk.database.transaction(() => {
    let embeddingOffset = 0;
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
        chunks: v.chunks.map((text_content, chunk_index) => ({
          chunk_index,
          chunk_type: "verbatim" as const,
          text_content,
          embedding: embeddings[embeddingOffset + chunk_index],
        })),
        namespace,
      });

      embeddingOffset += v.chunks.length;
      commitCatalogGraph(sdk, v, namespace);
      recordCatalog(sdk, "history", v.original, v.sourceId);
    }
    afterCommit();
  })();

  return { ingestedCount: validItems.length, skippedCount };
}

/** Standalone callers use the same two-phase boundary as the durable worker. */
export function processHistoryBatch(
  sdk: ShaleSDK,
  payload: HistoryBatchPayload,
  settings: Partial<BrowserExtensionSettings>,
  afterCommit: () => void = () => {},
) {
  return sdk.models.batch(
    () => prepareHistoryContent(sdk, payload, settings),
    (contents) => finalizeHistoryBatch(sdk, payload, settings, afterCommit, contents),
  );
}
