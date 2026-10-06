import { getSDK, type ShaleSDK } from "@shale/sdk";
import type { ProcessFileRequest, ProcessFileResponse, ProcessFilesBatchRequest, ProcessFilesBatchResponse } from "../../lib/messages.types";
import { documentBatchItems } from "./batch-items";
import { documentIdentity } from "./document-format";
import { prepareDocument } from "./parse-document";
import { positiveInteger } from "./settings.types";

/** Extract and summarize the whole batch before making any embedding requests. */
export async function processDocumentFilesBatch(
  request: ProcessFilesBatchRequest,
  sdkOverride?: ShaleSDK,
  signal?: AbortSignal,
): Promise<ProcessFilesBatchResponse> {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const items = documentBatchItems(request);
  const results: ProcessFileResponse[] = [];
  const response = (): ProcessFilesBatchResponse => {
    const errors = results.filter(result => !result.success)
      .map(result => ({ filePath: result.filePath, error: result.error ?? "Document processing failed" }));
    return { success: !errors.length, totalProcessed: results.length - errors.length, totalFailed: errors.length, results,
      ...(errors.length ? { errors } : {}) };
  };
  const prepare = async () => {
    await sdk.models.mapChat(items, async (item, index) => {
      signal?.throwIfAborted();
      try { results[index] = await prepareDocument(item, sdk, signal); }
      catch (error) {
        signal?.throwIfAborted();
        results[index] = { success: false, filePath: item.filePath, fileType: "document", ...documentIdentity(item.filePath),
          chunks: [], entities: [], edges: [], error: error instanceof Error ? error.message : String(error) };
      }
    });
  };
  const finalize = async () => {
    signal?.throwIfAborted();
    const pending = results.flatMap((result, index) => result.success && !items[index].options?.deferEmbedding
      ? result.chunks.filter(chunk => !chunk.embedding).map(chunk => ({ result, chunk })) : []);
    const batchSize = positiveInteger(sdk.settings.get("embeddingBatchSize"), 64);
    for (let start = 0; start < pending.length; start += batchSize) {
      signal?.throwIfAborted();
      const group = pending.slice(start, start + batchSize).filter(entry => entry.result.success);
      if (!group.length) continue;
      try {
        const embeddings = await sdk.embed(group.map(entry => entry.chunk.text_content), { signal });
        signal?.throwIfAborted();
        if (embeddings.length !== group.length || embeddings.some(vector => !vector?.length || vector.some(value => !Number.isFinite(value)))) {
          throw new Error("Embedding response did not contain a valid vector for every document chunk");
        }
        group.forEach((entry, index) => { entry.chunk.embedding = embeddings[index]; });
      } catch (error) {
        signal?.throwIfAborted();
        // Preserve parsed chunks for inspection/retry, but never report a partially embedded file as successful.
        for (const { result } of group) {
          result.success = false;
          result.error = error instanceof Error ? error.message : String(error);
        }
      }
    }
    return response();
  };
  if (!items.length) return response();
  if (items.every(item => item.options?.deferEmbedding)) {
    return sdk.models.phase("chat", async () => { await prepare(); return response(); });
  }
  return sdk.models.batch(prepare, finalize);
}

export async function processDocumentFile(
  request: ProcessFileRequest,
  sdkOverride?: ShaleSDK,
  signal?: AbortSignal,
): Promise<ProcessFileResponse> {
  const batch = await processDocumentFilesBatch({ ...request, files: documentBatchItems(request) }, sdkOverride, signal);
  const first = batch.results[0];
  return {
    ...(first ?? { success: false, filePath: request.filePath ?? "", fileType: "document", title: "", uri: "", chunks: [], entities: [], edges: [], error: "A document filePath is required" }),
    success: !!first && batch.success,
    ...(batch.errors?.length ? { error: batch.errors[0].error } : {}),
    ...(request.files || request.filePaths ? { results: batch.results, totalProcessed: batch.totalProcessed, totalFailed: batch.totalFailed } : {}),
  };
}

export default processDocumentFile;
