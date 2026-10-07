import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentCommand } from "./document-command";
import { ocrConfidence } from "./ocr-confidence";
import type { OcrPage } from "./extraction.types";

/** CPU OCR of complete PDF pages; successful page transcripts survive per-file deadlines. */
export async function ocrPdf(
  filePath: string, pageCount: number, language: string, chunkSize: number,
  cachedPages: Record<number, OcrPage>, signal: AbortSignal,
  savePage: (page: number, result: OcrPage) => void,
  selectedPages = Array.from({ length: pageCount }, (_, index) => index + 1),
) {
  if (!Bun.which("pdftoppm") || !Bun.which("tesseract"))
    throw new Error("Scanned PDF OCR requires local pdftoppm and tesseract executables");
  const directory = await mkdtemp(join(tmpdir(), "shale-pdf-ocr-"));
  const chunks: Array<{ text: string; metadata: Record<string, unknown> }> = [];
  const pages: string[] = [];
  const confidence: Record<number, number> = {};
  try {
    for (const page of selectedPages) {
      signal.throwIfAborted();
      let result = cachedPages[page];
      if (result === undefined) {
        const prefix = join(directory, "page");
        await documentCommand(["pdftoppm", "-f", String(page), "-l", String(page), "-r", "220", "-singlefile", "-png", filePath, prefix], signal);
        await documentCommand(["tesseract", `${prefix}.png`, prefix, "-l", language, "--dpi", "220", "txt", "tsv"], signal);
        result = { text: (await readFile(`${prefix}.txt`, "utf8")).trim(), confidence: ocrConfidence(await readFile(`${prefix}.tsv`, "utf8")) };
        savePage(page, result);
      }
      const { text } = result;
      confidence[page] = result.confidence;
      pages.push(text);
      for (let start = 0; start < text.length; start += chunkSize)
        chunks.push({ text: text.slice(start, start + chunkSize), metadata: { pageNumber: page, extractionMethod: "ocr", ocrEngine: "tesseract", ocrLanguage: language, ocrConfidence: result.confidence } });
    }
    return { text: pages.join("\n\n"), chunks, confidence };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
