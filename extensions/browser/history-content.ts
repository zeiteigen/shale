import type { ShaleSDK } from "@shale/sdk";
import type { WebPageParseResponse } from "../../lib/messages/web-contracts";
import type { HistoryBatchPayload } from "./types";
import type { BrowserExtensionSettings } from "./settings.types";
import { evaluateUrl } from "./filter";
import { isCatalogStale } from "./catalog-lifecycle";
import { ensureBrowserSchema } from "./storage-schema";
import { isSourceExcluded } from '../../lib/knowledge/exclusions';

export interface HistoryPageContent {
  url: string;
  fetchedAt: number;
  chunks: string[];
  extraction?: WebPageParseResponse["extraction"];
}

/** Fetch each eligible URL once; prepare all text before any embeddings start. */
export async function prepareHistoryContent(
  sdk: ShaleSDK,
  payload: HistoryBatchPayload,
  settings: Partial<BrowserExtensionSettings>,
): Promise<Array<HistoryPageContent | null>> {
  ensureBrowserSchema(sdk.database);
  if (settings.fetchHistoryPages === false) return payload.items.map(() => null);
  const fetched = new Map<string, Promise<HistoryPageContent | null>>();
  return sdk.models.mapChat(payload.items, async (item) => {
    const policy = evaluateUrl(item.url, settings);
    if (!policy.allowed || isCatalogStale(sdk, "history", item) || isSourceExcluded(sdk.database,undefined,policy.cleanUrl)) return null;
    let content = fetched.get(policy.cleanUrl);
    if (!content) {
      content = (async () => {
        try {
          // If we already have stored verbatim chunks from a live page capture, reuse them
          // to avoid redundant unauthenticated HTTP fetches that fail on authenticated pages.
          const existingSource = sdk.database
            .query<{ id: string }, [string]>(
              "SELECT id FROM sources WHERE uri = ? AND type = 'web_page' LIMIT 1",
            )
            .get(policy.cleanUrl);
          if (existingSource) {
            const cachedChunks = sdk.database
              .query<{ text_content: string }, [string]>(
                "SELECT text_content FROM chunks WHERE source_id = ? AND chunk_type = 'verbatim' ORDER BY chunk_index ASC",
              )
              .all(existingSource.id)
              .map((row) => row.text_content)
              .filter((c) => !c.startsWith("{\n  \"url\":") && !c.startsWith("{\"url\":"));
            if (cachedChunks.length > 0) {
              return {
                url: policy.cleanUrl,
                fetchedAt: Date.now(),
                chunks: cachedChunks,
                extraction: { method: "live-dom", version: "stored-chunks-v1", quality: "full", truncated: false,
                  originalChars: cachedChunks.reduce((total,chunk)=>total+chunk.length,0), reasons: [] },
              };
            }
          }

          const parsed = await sdk.messages.request("web:parse", {
            url: policy.cleanUrl,
            title: item.title,
            allowFetch: true,
            includeImages: false,
            enableLlmContext: false,
            chunkSize: settings.chunkSize,
          }, { target: "web-page-parser", timeoutMs: 20000 });
          if (!parsed.text.trim()) throw new Error("No readable page content");
          const chunks = parsed.chunks.filter((chunk) => chunk.trim());
          return {
            url: policy.cleanUrl,
            fetchedAt: Date.now(),
            chunks: chunks.length ? chunks : [parsed.text],
            extraction: parsed.extraction,
          };
        } catch (error) {
          sdk.logger.warn(`[History] Could not fetch/parse ${policy.cleanUrl}; using metadata: ${String(error)}`);
          return null;
        }
      })();
      fetched.set(policy.cleanUrl, content);
    }
    return content;
  });
}
