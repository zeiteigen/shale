import type { ParsedFile } from "./parse-file";
import { isDecorativeImageUrl } from "../../lib/decorative-images";
import { markdownImages } from "../../lib/markdown-images";

export const NOTE_IMAGE_POLICY_VERSION = 1;

/** Legacy compact checkpoints may retain icons after their original body was discarded. */
export function noteNeedsImageCleanup(file: ParsedFile): boolean {
  if (file.parsed?.images?.some(isDecorativeImageUrl)) return true;
  // Fresh parsing knows which tokens are literal code; bounded excerpts may lose those fences.
  if (file.imagePolicyVersion===NOTE_IMAGE_POLICY_VERSION) return false;
  const texts = [file.memory?.summary ?? "", ...(file.memory?.snippets.map(s => s.text) ?? []),
    ...(file.contextualChunks?.map(c => c.text_content) ?? [])];
  return texts.some(text => markdownImages(text).some(image => isDecorativeImageUrl(image.target)));
}
