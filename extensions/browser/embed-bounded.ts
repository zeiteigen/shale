import type { ShaleSDK } from "@shale/sdk";
import type { BrowserExtensionSettings } from "./settings.types";
/** Bound each embedding request and verify ownership around potentially long calls. */
export async function embedBounded(
  sdk: ShaleSDK,
  texts: string[],
  settings: Partial<BrowserExtensionSettings>,
  assertOwned: () => void = () => {},
) {
  const size = Math.max(1, Math.min(256, settings.maxEmbeddingTexts ?? 64));
  const embeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += size) {
    assertOwned();
    const batch = await sdk.embed(texts.slice(i, i + size));
    assertOwned();
    if (batch.length !== Math.min(size, texts.length - i))
      throw new Error("Embedding endpoint returned an incomplete batch");
    embeddings.push(...batch);
  }
  return embeddings;
}
