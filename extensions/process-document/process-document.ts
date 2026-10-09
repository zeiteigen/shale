import { getSDK, type ShaleSDK } from "@shale/sdk";
import type { ProcessFileRequest, ProcessFileResponse, ProcessFilesBatchRequest, ProcessFilesBatchResponse } from "../../lib/messages.types";
import { documentBatchItems } from "./batch-items";
import { documentIdentity } from "./document-format";
import { prepareDocument } from "./parse-document";

/** Extract and summarize documents in a chat batch. */
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
  if (!items.length) return response();
  return sdk.models.batch(prepare, async () => { signal?.throwIfAborted(); return response(); });
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
