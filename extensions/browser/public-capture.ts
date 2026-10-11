import type { ShaleSDK } from "@shale/sdk";
import type { PublicPageCapture } from "../../lib/browser-contract";
import type { BrowserExtensionSettings } from "./settings.types";
import { preparePageVisit } from "./page-ingest";
import { evaluateUrl } from "./filter";
/** Opt-in enrichment has fetched provenance and never claims a browser visit. */
export async function preparePublicCapture(
  sdk: ShaleSDK,
  payload: PublicPageCapture,
  settings: Partial<BrowserExtensionSettings>,
  options: { jobId?: string; managed?: boolean } = {},
) {
  if (settings.allowPublicPageEnrichment !== true) return null;
  const policy = evaluateUrl(payload.url, settings);
  if (!policy.allowed) return null;
  const parsed = await sdk.messages.request(
    "web:parse",
    {
      url: payload.url,
      title: payload.title,
      allowFetch: true,
      includeImages: false,
      enableLlmContext: false,
    },
    { target: "web-page-parser", timeoutMs: 20000 },
  );
  if (!parsed.text?.trim())
    throw new Error("Public-page fetch returned no readable content");
  return preparePageVisit(
    sdk,
    {
      ...payload,
      type: "page_visit",
      captureOrigin: "public-fetch",
      title: payload.title || parsed.title,
      url: payload.url,
      textContent: parsed.text,
      blocks: parsed.blocks,
      extraction: parsed.extraction
        ? {
            ...parsed.extraction,
            method: `public-fetch:${parsed.extraction.method}`,
          }
        : {
            method: "public-fetch",
            version: "blocks-v1",
            quality: "partial",
            truncated: false,
            originalChars: parsed.text.length,
            reasons: [],
          },
      images: parsed.imageUrls.map((url) => ({ url })),
      recordInSession: false,
      visitedAt: Date.now(),
    },
    settings,
    { ...options, managed: true, parsed },
  );
}
