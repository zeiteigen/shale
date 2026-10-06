import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { getSetting } from "@shale/sdk";

// Markdown stays on the note pipeline, even though process-document supports it.
export const DEFAULT_DOCUMENT_EXTENSIONS = [
  "pdf", "docx", "pptx", "xlsx", "odt", "odp", "ods", "rtf",
  "txt", "csv", "html", "epub",
];

export function isDocumentFile(filePath: string, extensions?: readonly string[]): boolean {
  const extension = extname(filePath).slice(1).toLowerCase();
  const supported = extensions ?? getSetting<string[]>("documentExtensions") ?? DEFAULT_DOCUMENT_EXTENSIONS;
  return extension !== "md" && supported.some(value => value.replace(/^\./, "").toLowerCase() === extension);
}

/** Scan attachments recursively, with the same hidden/ignored-folder rules as notes. */
export function findDocumentFiles(
  directory: string,
  ignoredDirectories: readonly string[] = [],
  extensions?: readonly string[],
): string[] {
  const ignored = new Set(ignoredDirectories.map(name => name.toLowerCase()));
  const files: string[] = [];
  const scan = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || ignored.has(entry.name.toLowerCase())) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.isFile() && isDocumentFile(path, extensions)) files.push(path);
    }
  };
  // A scanning failure must reach the caller so it cannot advance a watermark.
  scan(directory);
  return files;
}
