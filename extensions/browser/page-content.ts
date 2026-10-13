import { parseHTML } from "linkedom";
import type { PageVisitPayload } from "../../lib/browser-contract";
import { isDecorativeImage } from "../../lib/decorative-images";
import { extractDocument } from "../../lib/web-extraction";

type PageContent = Pick<PageVisitPayload,
  "url" | "title" | "textContent" | "captureOrigin" | "extraction" | "blocks" | "html" | "images">;

/** Capture failure metadata is activity, not a readable page body. */
export function isMetadataOnlyPage(page: PageContent): boolean {
  if (page.captureOrigin !== "tab-metadata" && page.extraction?.method !== "tab-metadata")
    return false;
  const clean = (text: string | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
  const metadata = new Set([clean(page.title), clean(page.url)]);
  const hasBody = (text: string | undefined) => !!clean(text) && !metadata.has(clean(text));
  if (hasBody(page.textContent) || page.blocks?.some((block) => hasBody(block.text)))
    return false;
  if (page.images?.some((image) => !isDecorativeImage(image))) return false;
  if (page.html?.trim()) {
    const snapshot = extractDocument(parseHTML(page.html).document as unknown as Document, page.url);
    if (hasBody(snapshot.text) || snapshot.images.length) return false;
  }
  return true;
}
