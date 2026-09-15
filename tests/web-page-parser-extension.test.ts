import { describe, expect, it } from "bun:test";
import { extractImageUrls, extractReadableText, chunkWebText, parseWebPage } from "../extensions/web-page-parser/parser";
import { canProcessImage, parseImageFile } from "../extensions/process-image/process-image";

describe("Web page parser extension", () => {
  it("extracts readable content, chunks it, and resolves image URLs", () => {
    const html = `<html><head><title>Guide</title><style>ignored</style></head><body><article><h1>A guide</h1><p>Useful text.</p><script>ignored()</script><img src="/diagram.png"></article></body></html>`;
    const text = extractReadableText(html);
    expect(text).toContain("A guide");
    expect(text).toContain("Useful text.");
    expect(text).not.toContain("ignored()");
    expect(extractImageUrls(html, "https://example.com/docs/page")).toEqual(["https://example.com/diagram.png"]);
    expect(chunkWebText("One. Two. Three.", 8).length).toBeGreaterThan(1);
  });

  it("accepts remote image URLs without converting them into file URIs", async () => {
    const sdk = {
      settings: { get: () => false },
      logger: { warn: () => {} },
      queryLLM: async () => "",
    } as any;
    expect(canProcessImage("https://cdn.example.com/chart.webp?width=800")).toBe(true);
    const parsed = await parseImageFile("https://cdn.example.com/chart.webp?width=800", sdk);
    expect(parsed.imageUri).toBe("https://cdn.example.com/chart.webp?width=800");
    expect(parsed.imageTitle).toBe("chart.webp");
  });

  it("merges live DOM image URLs with HTML-discovered images", async () => {
    const requests: string[] = [];
    const sdk = {
      settings: { getAll: () => ({ enableLlmContext: false, maxImages: 8 }) },
      messages: {
        request: async (_channel: string, payload: { filePath: string }) => {
          requests.push(payload.filePath);
          return { success: true, chunks: [{ text_content: `Visual: ${payload.filePath}`, chunk_type: "verbatim" }] };
        },
      },
      logger: { debug: () => {}, warn: () => {} },
    } as any;

    const result = await parseWebPage(sdk, {
      url: "https://example.com/article",
      textContent: "Article text",
      html: '<img src="/static-image.png">',
      imageUrls: ["https://cdn.example.com/lazy-image.webp"],
    });

    expect(result.imageUrls).toEqual([
      "https://cdn.example.com/lazy-image.webp",
      "https://example.com/static-image.png",
    ]);
    expect(requests).toEqual(result.imageUrls);
    expect(result.imageChunks.every((chunk) => chunk.chunk_type === "verbatim")).toBe(true);
  });
});
