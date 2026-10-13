import { stat } from "node:fs/promises";
import type { ShaleSDK } from "@shale/sdk";
import type { ChatConnector } from "@shale/sdk/chat/commit";
import { importExportFile, jsonFiles } from "./import-folder";

/** Files untouched for this long are treated as finished by the exporter. */
const SETTLED_MS = 20_000;
const POLL_MS = 10_000;
/** While a channel is still exporting, index what has arrived at most this often. */
const INDEX_EVERY_MS = 5 * 60_000;

/**
 * Imports exporter output as it is written: a file that has stopped changing and parses
 * as complete JSON is ingested immediately, and re-ingested if it changes again. Upserts
 * are idempotent, so the channel's watermark still advances only after the export ends.
 */
export class ProgressiveImport {
  private imported = new Map<string, number>();
  private stopped = false;
  private wake?: () => void;
  private lastIndexed = Date.now();
  private indexedChanges = 0;
  changed = 0;
  newest = 0;

  constructor(private sdk: ShaleSDK, private connector: ChatConnector, private dir: string,
    private index?: () => Promise<void>, private settledMs = SETTLED_MS, private pollMs = POLL_MS, private indexEveryMs = INDEX_EVERY_MS) {}

  get files() { return this.imported.size; }

  stop() { this.stopped = true; this.wake?.(); }

  private async scan(final: boolean) {
    for await (const path of jsonFiles(this.dir)) {
      let mtime: number;
      try { mtime = (await stat(path)).mtimeMs; } catch { continue; }
      if (this.imported.get(path) === mtime || (!final && Date.now() - mtime < this.settledMs)) continue;
      try {
        const result = await importExportFile(this.connector, path);
        this.changed += result.changed;
        this.newest = Math.max(this.newest, result.newest);
        this.imported.set(path, mtime);
      } catch (error) {
        // Still being written; picked up on a later scan. A final scan must surface the error.
        if (final) throw error;
      }
    }
  }

  async watch() {
    while (!this.stopped) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, this.pollMs);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
      this.wake = undefined;
      if (this.stopped) break;
      await this.scan(false);
      if (this.index && this.changed > this.indexedChanges && Date.now() - this.lastIndexed >= this.indexEveryMs) {
        this.sdk.logger.log(`Discord sync: indexing ${this.changed} message(s) received so far from a long export.`);
        await this.index();
        this.indexedChanges = this.changed;
        this.lastIndexed = Date.now();
      }
    }
  }

  async finish() {
    await this.scan(true);
    return { changed: this.changed, newest: this.newest };
  }
}
