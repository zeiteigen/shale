import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ShaleSDK } from "@shale/sdk";
import type { ChatConnector } from "@shale/sdk/chat/commit";
import { parseInstagramThread } from "./parse-export";
import { INSTAGRAM_DEFAULTS } from "./settings.types";

export interface ImportResult { files: number; skipped: number; messages: number; errors: string[] }

/** Every `message_N.json` below the folder, wherever the export nests `messages/inbox`. */
async function* threadFiles(dir: string): AsyncGenerator<string> {
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
    if (entry.isDirectory()) yield* threadFiles(path);
    else if (entry.isFile() && /^message_\d+\.json$/i.test(entry.name)) yield path;
  }
}

/** Import new or modified export files; unchanged files are skipped by size and mtime. */
export async function importFolder(sdk: ShaleSDK, connector: ChatConnector, dir: string, force = false): Promise<ImportResult> {
  const result: ImportResult = { files: 0, skipped: 0, messages: 0, errors: [] };
  for await (const path of threadFiles(dir)) {
    const info = await stat(path);
    const version = `${info.size}:${info.mtimeMs}`;
    const key = `import:${path}`;
    if (!force && sdk.state.getWatermark(key) === version) { result.skipped++; continue; }
    try {
      const parsed = parseInstagramThread(await Bun.file(path).json(), path);
      const { changed } = connector.store.ingest(parsed.conversation, parsed.messages,
        { nearDuplicateMs: INSTAGRAM_DEFAULTS.nearDuplicateMs });
      result.files++;
      result.messages += changed;
      sdk.state.setWatermark(version, key);
    } catch (error) {
      result.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      sdk.logger.error(`Failed to import Instagram export ${path}:`, error);
    }
  }
  return result;
}
