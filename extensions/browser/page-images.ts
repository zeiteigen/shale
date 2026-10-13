import type { WebPageParseResponse } from "../../lib/messages/web-contracts";
import { isDecorativeImage, isDecorativeImageUrl } from "../../lib/decorative-images";
import { prepareSourceMemory } from "../../lib/memory/prepare";
import type { PreparedPageData, WebPageData } from "./types";

function decorativeAsset(page: Pick<WebPageData, "images">, value: unknown): boolean {
  if (typeof value !== "string") return false;
  return isDecorativeImageUrl(value) ||
    !!page.images?.some((image) => image.url === value && isDecorativeImage(image));
}

/** Keep parser evidence indexes aligned when an older parser returns page chrome. */
export function filterPageImages(parser: WebPageParseResponse, page: Pick<WebPageData, "images">): WebPageParseResponse {
  const indexes = new Map<number, number>();
  const imageChunks = parser.imageChunks.filter((chunk, index) => {
    if (decorativeAsset(page, chunk.metadata?.assetUri)) return false;
    indexes.set(index, indexes.size);
    return true;
  });
  return {
    ...parser,
    imageUrls: parser.imageUrls.filter((url) => !decorativeAsset(page, url)),
    imageChunks,
    imageKnowledge: parser.imageKnowledge?.filter((image) => !decorativeAsset(page, image.uri))
      .map((image) => ({ ...image, claims: image.claims.flatMap((claim) => {
        const chunkIndex = indexes.get(claim.chunkIndex);
        return chunkIndex === undefined ? [] : [{ ...claim, chunkIndex }];
      }) })),
  };
}

/** Recovery and staged caches may contain image snippets prepared before filtering. */
export function sanitizePreparedPageImages(prepared: PreparedPageData): boolean {
  const snippets = prepared.memory.snippets.filter((snippet) =>
    !decorativeAsset(prepared.pageData, snippet.locator.assetUri));
  const changed = snippets.length !== prepared.memory.snippets.length;
  if (changed) {
    const rebuilt = prepareSourceMemory(snippets.map((snippet) => ({
      text_content: snippet.text,
      chunk_type: snippet.kind === "excerpt" ? "verbatim" : "synthetic",
      metadata: snippet.locator,
    })), { title: prepared.pageData.title });
    // Keep the original excerpt locators and stable snippet identities.
    prepared.memory = { ...rebuilt, snippets };
    prepared.analysis = { ...prepared.analysis, summary: rebuilt.summary };
    prepared.pageData = { ...prepared.pageData,
      textContent: snippets.filter((snippet) => snippet.kind === "excerpt").map((snippet) => snippet.text).join("\n\n"),
      excerpt: rebuilt.summary.slice(0, 300),
    };
  }
  prepared.imageKnowledge = prepared.imageKnowledge?.filter((image) =>
    !decorativeAsset(prepared.pageData, image.uri));
  prepared.pageData.images = prepared.pageData.images?.filter((image) => !isDecorativeImage(image));
  return changed;
}
