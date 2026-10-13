import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ShaleSDK } from "@shale/sdk";
import type { ChatConnector } from "@shale/sdk/chat/commit";
import { parseDiscordExport } from "./parse-dce";

export interface ImportResult { files: number; skipped: number; messages: number; errors: string[] }

async function* jsonFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonFiles(path);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) yield path;
  }
}

/** Ingest one exporter JSON file; returns the newest message timestamp it contained. */
export async function importExportFile(connector: ChatConnector, path: string) {
  const parsed = parseDiscordExport(await Bun.file(path).json());
  const { changed } = connector.policy?.ingest?.(parsed.conversation,parsed.messages)
    ?? connector.store.ingest(parsed.conversation, parsed.messages);
  connector.policy?.observe?.(parsed.conversation, parsed.messages);
  const newest = parsed.messages.reduce((max, m) => Math.max(max, m.sentAt), 0);
  return { changed, newest, skipped: parsed.skipped, conversation: parsed.conversation };
}

/** Import new or modified exports from a folder; unchanged files are skipped by size and mtime. */
export async function importFolder(sdk: ShaleSDK, connector: ChatConnector, dir: string, force = false): Promise<ImportResult> {
  const result: ImportResult = { files: 0, skipped: 0, messages: 0, errors: [] };
  for await (const path of jsonFiles(dir)) {
    const info = await stat(path);
    const version = `${info.size}:${info.mtimeMs}`;
    const key = `import:${path}`;
    if (!force && sdk.state.getWatermark(key) === version) { result.skipped++; continue; }
    try {
      const imported = await importExportFile(connector, path);
      result.files++;
      result.messages += imported.changed;
      sdk.state.setWatermark(version, key);
    } catch (error) {
      result.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      sdk.logger.error(`Failed to import Discord export ${path}:`, error);
    }
  }
  return result;
}

export { jsonFiles };
