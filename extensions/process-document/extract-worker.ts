import { readFile, stat } from "node:fs/promises";
import { parseOffice } from "officeparser";
import type { ExtractionRequest, ExtractionReply, ExtractedDocument } from "./extraction.types";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<ExtractionRequest>) => void;
  postMessage: (reply: ExtractionReply) => void;
};

async function extract(request: ExtractionRequest): Promise<ExtractedDocument> {
  const { filePath, format, maxFileBytes, chunkSize, includeNotes } = request;
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("The document path must refer to a regular file");
  if (info.size > maxFileBytes) throw new Error(`Document exceeds the ${maxFileBytes} byte size limit`);
  const buffer = await readFile(filePath);
  if (buffer.length > maxFileBytes) throw new Error(`Document exceeds the ${maxFileBytes} byte size limit`);
  const common = {
    format,
    updatedAt: Math.floor(info.mtimeMs),
    assetHash: new Bun.CryptoHasher("sha256").update(buffer).digest("hex"),
  };
  if (format === "txt") {
    const text = buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
    const chunks: ExtractedDocument["chunks"] = [];
    for (let start = 0; start < text.length; start += chunkSize) {
      chunks.push({ text: text.slice(start, start + chunkSize), metadata: { sourceType: "txt" } });
    }
    return { ...common, text, chunks, metadata: {}, warnings: [] };
  }

  if (format === "pdf") {
    // Preload the local fake-worker module: PDF.js's automatic worker import
    // stalls under Bun. It runs inside our cancellable worker, never the host.
    (globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker =
      await import(import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"));
  }
  const ast = await parseOffice(buffer, {
    fileType: format,
    ignoreNotes: !includeNotes,
    extractAttachments: false,
    ocr: false,
    includeRawContent: false,
    // Isolation and deadlines are already owned by this Bun worker. Avoid the
    // parser's Node child-process pool, which does not work inside Bun workers.
    pdfParserConfig: { separateProcess: false, extractTextColor: false },
  });
  const splitBy = format === "pdf" ? "page"
    : format === "pptx" || format === "odp" ? "slide"
    : format === "xlsx" || format === "ods" || format === "csv" ? "sheet"
    : "heading";
  const text = (await ast.to("text", { renderMetadata: false, includeImages: "none" })).value.trim();
  const generated = await ast.to("chunks", {
    includeImages: "none",
    chunksConfig: { strategy: "document-structure", splitBy, maxChunkSize: chunkSize, tableSplitStrategy: "row" },
  });
  const { title, author, subject, keywords, language, created, modified, pages } = ast.metadata;
  return {
    ...common,
    text,
    chunks: generated.value.filter(chunk => chunk.text.trim()),
    metadata: {
      title, author, subject, keywords, language, created, modified, pages,
      pageCount: ast.content.filter(node => node.type === "page").length || undefined,
      slideCount: ast.content.filter(node => node.type === "slide").length || undefined,
      sheetCount: ast.content.filter(node => node.type === "sheet").length || undefined,
    },
    warnings: [...ast.warnings, ...generated.messages].map(warning => warning.message),
  };
}

scope.onmessage = async ({ data }) => {
  try { scope.postMessage({ document: await extract(data) }); }
  catch (error) { scope.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
