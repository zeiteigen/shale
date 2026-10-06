import type { ProcessFileRequest, ProcessFilesBatchItem } from "../../lib/messages.types";

export function documentBatchItems(request: ProcessFileRequest): ProcessFilesBatchItem[] {
  const files = request.files ?? request.filePaths ?? (request.filePath ? [request.filePath] : []);
  return files.map(file => {
    const item = typeof file === "string" ? { filePath: file } : file;
    return {
      ...item,
      mimeType: item.mimeType ?? request.mimeType,
      fileType: item.fileType ?? request.fileType,
      contextEntity: item.contextEntity ?? request.contextEntity,
      options: { ...request.options, ...item.options },
    };
  });
}
