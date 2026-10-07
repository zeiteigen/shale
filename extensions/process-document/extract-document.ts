import type { ExtractionRequest, ExtractionReply, ExtractedDocument, OcrPageStore } from "./extraction.types";

/** A dedicated worker keeps synchronous parser work off the host event loop. */
export function extractDocument(
  request: ExtractionRequest,
  timeoutMs: number,
  signal?: AbortSignal,
  ocrStore?: OcrPageStore,
): Promise<ExtractedDocument> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./extract-worker.ts", import.meta.url).href);
    let settled = false;
    const finish = (error?: unknown, document?: ExtractedDocument) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error !== undefined) {
        // Give asynchronous OCR subprocesses time to receive cancellation and clean up.
        worker.postMessage({ type: "abort" });
        setTimeout(() => worker.terminate(), 1000);
      } else worker.terminate();
      if (error !== undefined) reject(error);
      else resolve(document!);
    };
    const abort = () => finish(signal?.reason ?? new Error("Document parsing aborted"));
    const timer = setTimeout(() => finish(new Error(`Document parsing timed out after ${timeoutMs}ms`)), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<ExtractionReply>) => {
      if (settled) return;
      if ("ocrCache" in data || "ocrPage" in data) {
        try {
          if ("ocrCache" in data) worker.postMessage({ type: "ocrCache", pages: ocrStore?.load(data.ocrCache.key, data.ocrCache.pages) ?? {} });
          else ocrStore?.save(data.ocrPage.key, data.ocrPage.page, data.ocrPage.result);
        } catch (error) { finish(error); }
        return;
      }
      if ("error" in data) finish(new Error(data.error));
      else finish(undefined, data.document);
    };
    worker.onerror = event => {
      event.preventDefault();
      finish(new Error(event.message || "Document parser worker failed"));
    };
    worker.postMessage(request);
    if (signal?.aborted) abort();
  });
}
