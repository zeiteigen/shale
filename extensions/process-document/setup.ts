import { getSDK, type ShaleSDK } from "@shale/sdk";
import type { CanProcessFileRequest, CanProcessFilesRequest, MessageContext, ProcessFileRequest, ProcessFilesBatchRequest } from "../../lib/messages.types";
import { documentBatchItems } from "./batch-items";
import { canProcessDocument } from "./document-format";
import { processDocumentFile, processDocumentFilesBatch } from "./process-document";

export async function setup(sdkOverride?: ShaleSDK): Promise<void> {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const canProcess = (filePath: string, hints?: { mimeType?: string; fileType?: string }) =>
    canProcessDocument(filePath, sdk.settings.get<string[]>("supportedExtensions"), hints);
  const accepts = (request: ProcessFileRequest) => {
    const items = documentBatchItems(request);
    // The bus chooses one handler per request; never claim an unrelated mixed batch.
    return items.length > 0 && items.every(item => item.fileType === "document" || canProcess(item.filePath, item));
  };
  const targeted = (context: MessageContext) => context.target?.toLowerCase() === "process-document";
  const registration = { name: "process-document", priority: 20,
    canHandle: (request: ProcessFileRequest, context: MessageContext) => targeted(context) || accepts(request) };
  sdk.messages.handle("file:process", (request: ProcessFileRequest, context) =>
    processDocumentFile(request, sdk, context.signal), registration);
  const batchHandler = (request: ProcessFilesBatchRequest, context: MessageContext) =>
    processDocumentFilesBatch(request, sdk, context.signal);
  sdk.messages.handle("files:process", batchHandler, registration);
  sdk.messages.handle("file:process-batch", batchHandler, registration);
  sdk.messages.handle("file:can-process", async (request: CanProcessFileRequest) => {
    const supported = canProcess(request.filePath, request);
    return { canProcess: supported, supportedBy: supported ? "process-document" : undefined, priority: 20 };
  }, { name: "process-document", priority: 20,
    canHandle: (request, context) => targeted(context) || request.fileType === "document" || canProcess(request.filePath, request) });
  sdk.messages.handle("files:can-process", async (request: CanProcessFilesRequest) => {
    const results = Object.fromEntries(request.filePaths.map(filePath => {
      const supported = canProcess(filePath, request);
      return [filePath, { canProcess: supported, supportedBy: supported ? "process-document" : undefined, priority: 20 }];
    }));
    return { canProcessAll: request.filePaths.length > 0 && Object.values(results).every(result => result.canProcess), results };
  }, { name: "process-document", priority: 20,
    canHandle: (request, context) => targeted(context) || request.fileType === "document" || request.filePaths.some(path => canProcess(path, request)) });
  sdk.logger.info("process-document extension message handlers registered.");
}

export default setup;
