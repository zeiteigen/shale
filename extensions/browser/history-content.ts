import type { ShaleSDK } from "@shale/sdk";
import type { WebPageParseResponse } from "../../lib/messages/web-contracts";
import type { HistoryBatchPayload } from "./types";
import type { BrowserExtensionSettings } from "./settings.types";
import { evaluateUrl } from "./filter";
import { isCatalogStale } from "./catalog-lifecycle";
import { ensureBrowserSchema } from "./storage-schema";

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
    if (!policy.allowed || isCatalogStale(sdk, "history", item)) return null;
    let content = fetched.get(policy.cleanUrl);
    if (!content) {
      content = (async () => {
        try {
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
