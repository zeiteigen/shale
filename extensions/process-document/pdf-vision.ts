import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShaleSDK } from "@shale/sdk";
import type { ExtractedDocument } from "./extraction.types";
import { documentCommand } from "./document-command";
import { transcription, queryTranscription } from "./vision-transcription";

/** Transcribe uncertain OCR pages during preparation; cache each completed model output. */
export async function refinePdfPages(
  document: ExtractedDocument, filePath: string, sdk: ShaleSDK,
  chunkSize: number, minimumConfidence: number, signal = new AbortController().signal,
) {
  const scores = document.metadata.ocrConfidence as Record<number, number> | undefined;
  const pages = Object.keys(scores ?? {}).map(Number).filter(page => scores![page] < minimumConfidence);
  if (!pages.length) return;
  const model = sdk.llm.options().model!;
  const directory = await mkdtemp(join(tmpdir(), "shale-pdf-vision-"));
  try {
    for (const page of pages) {
      signal.throwIfAborted();
      const key = `pdf-vision:v2:${document.assetHash}:${model}:${page}`;
      const cached = sdk.state.get(key);
      let result;
      if (cached !== null) result = transcription(JSON.parse(cached));
      else {
        const prefix = join(directory, "page");
        await documentCommand(["pdftoppm", "-f", String(page), "-l", String(page), "-scale-to", "2000", "-singlefile", "-png", filePath, prefix], signal);
        const image = `data:image/png;base64,${Buffer.from(await Bun.file(`${prefix}.png`).arrayBuffer()).toString("base64")}`;
        result = await queryTranscription(sdk, image, page, model, signal);
        sdk.state.set(key, JSON.stringify(result));
        sdk.logger.info(`[Vision transcription] ${filePath}: page ${page}`);
      }
      const replacement: ExtractedDocument["chunks"] = [];
      for (let start = 0; start < result.text.length; start += chunkSize)
        replacement.push({ text: result.text.slice(start, start + chunkSize), metadata: {
          pageNumber: page, extractionMethod: "vision-transcription", model,
        } });
      document.chunks = document.chunks.filter(chunk => chunk.metadata.pageNumber !== page).concat(replacement);
    }
    document.chunks.sort((a, b) => Number(a.metadata.pageNumber) - Number(b.metadata.pageNumber));
    document.text = document.chunks.map(chunk => chunk.text).join("\n\n");
    document.metadata.visionTranscribedPages = pages;
    document.warnings.push("Uncertain OCR pages were transcribed by a vision model; verify unclear handwriting and equations against the original page.");
  } finally { await rm(directory, { recursive: true, force: true }); }
}
