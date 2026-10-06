import { basename, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_DOCUMENT_EXTENSIONS = [
  "pdf", "docx", "pptx", "xlsx", "odt", "odp", "ods", "rtf",
  "txt", "csv", "md", "html", "epub",
] as const;

export type DocumentFormat = typeof DEFAULT_DOCUMENT_EXTENSIONS[number];

const mimeFormats: Record<string, DocumentFormat> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/html": "html",
  "application/epub+zip": "epub",
};

export function documentPath(filePath: string): string {
  if (!filePath.trim()) throw new Error("A document filePath is required");
  if (/^file:/i.test(filePath)) return fileURLToPath(filePath);
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(filePath)) {
    throw new Error("process-document accepts local paths and file:// URLs only");
  }
  return resolve(filePath);
}

export function documentIdentity(filePath: string): { title: string; uri: string } {
  try {
    const path = documentPath(filePath);
    return { title: basename(path), uri: pathToFileURL(path).href };
  } catch {
    return { title: basename(filePath), uri: filePath };
  }
}

export function documentFormat(
  filePath: string,
  hints?: { mimeType?: string; fileType?: string },
): DocumentFormat | undefined {
  let path: string;
  try { path = documentPath(filePath); } catch { return undefined; }
  const extension = extname(path).slice(1).toLowerCase();
  // A hint may identify extensionless files, but cannot relabel unsupported files.
  const format = extension || mimeFormats[hints?.mimeType?.split(";")[0].trim().toLowerCase() ?? ""] || hints?.fileType?.toLowerCase();
  return DEFAULT_DOCUMENT_EXTENSIONS.find(candidate => candidate === format);
}

export function canProcessDocument(
  filePath: string,
  supportedExtensions: readonly string[] = DEFAULT_DOCUMENT_EXTENSIONS,
  hints?: { mimeType?: string; fileType?: string },
): boolean {
  const format = documentFormat(filePath, hints);
  return !!format && supportedExtensions.some(extension => extension.replace(/^\./, "").toLowerCase() === format);
}
