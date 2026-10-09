import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createExtensionSDK, createMessageBus } from "../sdk";
import { canProcessDocument, parseDocumentFile } from "../extensions/process-document";
import { extractDocument } from "../extensions/process-document/extract-document";
import { createTestDatabase } from "./fixtures/database";
import { writeDocumentFixtures, textPdf } from "./fixtures/documents";

const directory = mkdtempSync(join(tmpdir(), "shale-documents-"));
const files = writeDocumentFixtures(directory);
const database = createTestDatabase();
const sdk = createExtensionSDK("process-document", { database, messageBus: createMessageBus(), extensionDir: directory });
afterAll(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

describe("document parsers", () => {
  for (const [format, text] of Object.entries({
    pdf: "First page evidence", docx: "Local document extraction", pptx: "First slide evidence", xlsx: "Document count",
    odt: "Open formats", odp: "Open presentation evidence", ods: "OpenDocument count", epub: "Electronic books",
    rtf: "Rich text evidence", txt: "Plain document evidence", csv: "Evidence", md: "Local knowledge", html: "Readable document details",
  })) {
    it(`extracts real ${format} content without a model endpoint`, async () => {
      const result = await parseDocumentFile(files[format], sdk);
      expect(result.success).toBe(true);
      expect(result.chunks.map(chunk => chunk.text_content).join("\n")).toContain(text);
      expect(result.chunks.every(chunk => chunk.chunk_type === "verbatim" && typeof chunk.text_content === "string")).toBe(true);
      expect(result.metadata?.format).toBe(format);
      expect(result.metadata?.assetHash).toMatch(/^[a-f\d]{64}$/);
      expect(result.metadata?.updatedAt).toBeGreaterThan(0);
    });
  }

  it("preserves Word metadata, tables, and encoded file URLs", async () => {
    const result = await parseDocumentFile(pathToFileURL(files.docx).href, sdk);
    expect(result.title).toBe("Research report");
    expect(result.metadata?.author).toBe("Shale");
    expect(result.uri).toBe(pathToFileURL(files.docx).href);
    expect(result.entities[0].identityKey).toBe(result.uri);
    expect(result.chunks.map(chunk => chunk.text_content).join("\n")).toContain("99 percent");
  });

  it("retains distinct page, slide, and sheet references", async () => {
    const pdf = await parseDocumentFile(files.pdf, sdk);
    expect(pdf.metadata?.pageCount).toBe(2);
    expect(pdf.chunks.find(chunk => chunk.text_content.includes("First page"))?.metadata?.pageNumber).toBe(1);
    expect(pdf.chunks.find(chunk => chunk.text_content.includes("Second page"))?.metadata?.pageNumber).toBe(2);
    const pptx = await parseDocumentFile(files.pptx, sdk);
    expect(pptx.metadata?.slideCount).toBe(2);
    expect(pptx.chunks.find(chunk => chunk.text_content.includes("First slide"))?.metadata?.slideNumber).toBe(1);
    expect(pptx.chunks.find(chunk => chunk.text_content.includes("Second slide"))?.metadata?.slideNumber).toBe(2);
    const xlsx = await parseDocumentFile(files.xlsx, sdk);
    expect(xlsx.chunks[0].metadata?.sheetName).toBe("Results");
  });

  it("honors hot-reloaded chunk sizes, note inclusion, and disabled formats", async () => {
    const included = await parseDocumentFile(files.pptx, sdk);
    expect(included.chunks.map(chunk => chunk.text_content).join("\n")).toContain("Speaker note context");
    writeFileSync(join(directory, "settings.json"), JSON.stringify({ includeNotes: false, chunkSize: 12 }));
    try {
      const excluded = await parseDocumentFile(files.pptx, sdk);
      expect(excluded.chunks.map(chunk => chunk.text_content).join("\n")).not.toContain("Speaker note context");
      expect(excluded.chunks.every(chunk => chunk.text_content.length <= 12)).toBe(true);
      writeFileSync(join(directory, "settings.json"), JSON.stringify({ supportedExtensions: ["pdf"] }));
      await expect(parseDocumentFile(files.docx, sdk)).rejects.toThrow("disabled");
    } finally { rmSync(join(directory, "settings.json"), { force: true }); }
  });

  it("recognizes only implemented local formats and accurate extensionless hints", () => {
    expect(canProcessDocument("REPORT.PDF")).toBe(true);
    expect(canProcessDocument(pathToFileURL(files.docx).href)).toBe(true);
    expect(canProcessDocument("download", undefined, { mimeType: "application/pdf" })).toBe(true);
    expect(canProcessDocument("legacy.doc")).toBe(false);
    expect(canProcessDocument("image.png", undefined, { fileType: "pdf" })).toBe(false);
    expect(canProcessDocument("https://example.com/report.pdf")).toBe(false);
    expect(canProcessDocument("report.pdf", ["docx"])).toBe(false);
  });

  it("reports missing, corrupt, legacy, and textless documents", async () => {
    await expect(parseDocumentFile(join(directory, "missing.pdf"), sdk)).rejects.toThrow();
    const corrupt = join(directory, "corrupt.docx");
    writeFileSync(corrupt, "broken archive");
    await expect(parseDocumentFile(corrupt, sdk)).rejects.toThrow();
    await expect(parseDocumentFile("legacy.doc", sdk)).rejects.toThrow("converted");
    const empty = join(directory, "empty.pdf");
    writeFileSync(empty, textPdf([""]));
    await expect(parseDocumentFile(empty, sdk)).rejects.toThrow("OCR");
  });

  it("enforces input size limits and terminates timed-out or cancelled workers", async () => {
    const request = { filePath: files.docx, format: "docx" as const, maxFileBytes: 100000, chunkSize: 1800, includeNotes: true };
    await expect(extractDocument({ ...request, maxFileBytes: 1 }, 60000)).rejects.toThrow("size limit");
    await expect(extractDocument(request, 1)).rejects.toThrow("timed out");
    const controller = new AbortController();
    const pending = extractDocument(request, 60000, controller.signal);
    controller.abort(new Error("Stop document parsing"));
    await expect(pending).rejects.toThrow("Stop document parsing");
  });
});
