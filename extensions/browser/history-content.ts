import type { ShaleSDK } from "@shale/sdk";
import type { WebPageParseResponse } from "../../lib/messages/web-contracts";
import type { HistoryBatchPayload } from "./types";
import type { BrowserExtensionSettings } from "./settings.types";
import type { PreparedPageData } from "./types";
import { evaluateUrl } from "./filter";
import { isCatalogStale } from "./catalog-lifecycle";
import { ensureBrowserSchema } from "./storage-schema";
import { isSourceExcluded } from '../../lib/knowledge/exclusions';
import { preparePageVisit } from "./page-ingest";

export interface HistoryPageContent {
  url: string;
  fetchedAt: number;
  extraction?: WebPageParseResponse["extraction"];
  origin: "live-dom" | "public-fetch";
  preparedPage?: PreparedPageData;
}

/** Fetch each eligible URL once and prepare its extracted text. */
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
          // Existing live captures already own the page memory. History should
          // point at that page rather than fetch and duplicate its body.
          const existingSource = sdk.database
            .query<{ id: string }, [string]>(
              "SELECT id FROM sources WHERE uri = ? AND type IN ('web_page','public_web_page') LIMIT 1",
            )
            .get(policy.cleanUrl);
          if (existingSource) {
            const retained = sdk.memory.get(existingSource.id);
            const receipt = sdk.database.query<{ quality: string | null }, [string, string]>(
              `SELECT json_extract(prepared,'$.extraction.quality') AS quality FROM browser_content_cache
               WHERE extension_id=? AND source_id=? AND json_extract(prepared,'$.cacheState')='complete'
              ORDER BY updated_at DESC LIMIT 1`).get(sdk.extensionId, existingSource.id);
            const coverage = retained.coverage as { inputCharacters?: number };
            return {
              url: policy.cleanUrl,
              fetchedAt: Date.now(),
              origin: "live-dom",
              extraction: { method: "stored-memory", version: "memory-v1", quality: (receipt?.quality ?? "partial") as "full" | "partial" | "metadata", truncated: false,
                originalChars: coverage.inputCharacters ?? 0, reasons: ["Reused existing canonical source memory"] },
            };
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
          const fetchedAt = Date.now();
          const preparedPage = await preparePageVisit(sdk, {
            type: "page_visit",
            url: policy.cleanUrl,
            title: item.title || parsed.title,
            textContent: parsed.text,
            blocks: parsed.blocks,
            extraction: parsed.extraction,
            captureOrigin: "public-fetch",
            visitedAt: fetchedAt,
            capturedAt: fetchedAt,
            recordInSession: false,
            recordId: `history-page:${policy.cleanUrl}`,
          }, settings, { managed: true, parsed });
          return {
            url: policy.cleanUrl,
            fetchedAt,
            origin: "public-fetch",
            extraction: parsed.extraction,
            preparedPage: preparedPage ?? undefined,
          };
        } catch (error) {
          sdk.logger.warn(`[History] Could not fetch/parse ${policy.cleanUrl}; using metadata: ${String(error)}`);
          return null;
        }
      })();
      fetched.set(policy.cleanUrl, content);
    }
    return content ?? null;
  });
}
