import { expect, it } from "bun:test";
import { createExtensionSDK } from "../sdk";
import { createTestDatabase } from "./fixtures/database";
import { refinePdfPages } from "../extensions/process-document/pdf-vision";
import type { ExtractedDocument } from "../extensions/process-document/extraction.types";

function document(): ExtractedDocument {
  return { format: "pdf", text: "garbled OCR\nReliable printed text", updatedAt: 100, assetHash: "asset",
    chunks: [{ text: "garbled OCR", metadata: { pageNumber: 1, extractionMethod: "ocr" } },
      { text: "Reliable printed text", metadata: { pageNumber: 2, extractionMethod: "ocr" } }],
    metadata: { ocrConfidence: { 1: 15, 2: 95, 3: 0 } }, warnings: [] };
}

it("resumes cached vision pages, preserves confident OCR, and removes explicitly blank pages", async () => {
  const database = createTestDatabase();
  const sdk = createExtensionSDK("process-document", { database, models: { chat: { model: "vision-test" } } });
  try {
    sdk.state.set("pdf-vision:v2:asset:vision-test:1", JSON.stringify({ text: "Polar coordinates use radial and angular unit vectors.", blank: false }));
    sdk.state.set("pdf-vision:v2:asset:vision-test:3", JSON.stringify({ text: "", blank: true }));
    sdk.queryLLM = (async () => { throw Error("Cached transcriptions must not issue model requests"); }) as any;
    const parsed = document();
    await refinePdfPages(parsed, "/unused.pdf", sdk, 100, 60);
    expect(parsed.text).toContain("Polar coordinates");
    expect(parsed.text).toContain("Reliable printed text");
    expect(parsed.text).not.toContain("garbled");
    expect(parsed.chunks.map(chunk => chunk.metadata.pageNumber)).toEqual([1, 2]);
    expect(parsed.chunks[0].metadata).toMatchObject({ extractionMethod: "vision-transcription", model: "vision-test" });
    expect(parsed.metadata.visionTranscribedPages).toEqual([1, 3]);
  } finally { database.close(); }
});

it("rejects contradictory blank output rather than silently discarding readable content", async () => {
  const database = createTestDatabase();
  const sdk = createExtensionSDK("process-document", { database, models: { chat: { model: "vision-test" } } });
  try {
    sdk.state.set("pdf-vision:v2:asset:vision-test:1", JSON.stringify({ text: "Visible equation", blank: true }));
    await expect(refinePdfPages(document(), "/unused.pdf", sdk, 100, 60)).rejects.toThrow("cannot also contain");
  } finally { database.close(); }
});

it("rejects malformed mathematical glyphs instead of caching control characters", async () => {
  const database = createTestDatabase();
  const sdk = createExtensionSDK("process-document", { database, models: { chat: { model: "vision-test" } } });
  try {
    sdk.state.set("pdf-vision:v2:asset:vision-test:1", JSON.stringify({ text: "\u0001 -> angular unit vector", blank: false }));
    await expect(refinePdfPages(document(), "/unused.pdf", sdk, 100, 60)).rejects.toThrow("control characters");
  } finally { database.close(); }
});
