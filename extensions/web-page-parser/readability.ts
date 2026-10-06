import { parseHTML } from "linkedom";
import { extractDocument } from "../../lib/web-extraction";
/** Never execute scripts or fetch subresources when parsing an HTML snapshot. */
export function parseHtmlSnapshot(
  html: string,
  url: string,
  maxChars = 100000,
) {
  const { document } = parseHTML(
    /<html\b/i.test(html)
      ? html
      : `<html><head></head><body>${html}</body></html>`,
  );
  return extractDocument(document as unknown as Document, url, maxChars);
}
