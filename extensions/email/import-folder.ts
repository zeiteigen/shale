import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ShaleSDK } from "@shale/sdk";
import type { ChatConnector } from "@shale/sdk/chat/commit";
import type { EmailSettings } from "./settings.types";
import { ingestEmail } from "./ingest";
import { readerEvents } from "./reader";

async function* mailFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* mailFiles(path);
    else if (entry.isFile() && /\.(eml|mbox)$/i.test(entry.name)) yield path;
  }
}

export async function importFolder(sdk: ShaleSDK, connector: ChatConnector, settings: EmailSettings, dir: string, force = false) {
  const result = { files: 0, skipped: 0, messages: 0, errors: [] as string[] };
  for await (const path of mailFiles(dir)) {
    try {
      const info = await stat(path);
      const version = `${info.size}:${info.mtimeMs}`;
      const key = `import:${path}`;
      if (!force && sdk.state.getWatermark(key) === version) { result.skipped++; continue; }
      for await (const event of readerEvents(settings, { action: "import", path })) {
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "message") result.messages += ingestEmail(sdk, connector, event.record);
      }
      // A file changing during a read is retried rather than marked complete.
      const after = await stat(path);
      if (`${after.size}:${after.mtimeMs}` !== version) throw new Error("Export changed during import; it will be retried.");
      sdk.state.setWatermark(version, key);
      result.files++;
    } catch (error) {
      result.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      sdk.logger.error(`Failed to import email export ${path}:`, error);
    }
  }
  return result;
}
