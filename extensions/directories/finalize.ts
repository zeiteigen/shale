import type { ShaleSDK } from "@shale/sdk";
import { pathToFileURL } from "node:url";
import { commitFile } from "./commit";
import { fileVersion } from "./scan";
import type { PendingDirectoryFile } from "./types";

/** Commit prepared files; failed files remain checkpointed. */
export async function finalizeFiles(sdk: ShaleSDK, files: PendingDirectoryFile[]) {
  for (const { id, data, result } of files) {
    try {
      if ((await fileVersion(data.filePath)).fingerprint !== data.fingerprint) {
        throw new Error("File changed after preparation; it will be retried on the next scan");
      }
      const committed = commitFile(sdk, id, data);
      result.filesProcessed++;
      result.chunksCreated += committed.chunksCount;
      if (committed.skipped) continue;
      try {
        await sdk.messages.publish("source:ingested", { sourceId: committed.sourceId, type: data.parsed.fileType,
          uri: pathToFileURL(data.filePath).href, title: data.parsed.title, origin: "directories",
          namespace: data.namespace, chunksCount: committed.chunksCount, timestamp: Date.now() });
      } catch (error) {
        sdk.logger.warn(`Source committed but source:ingested notification failed for ${data.filePath}:`, error);
      }
    } catch (error) {
      result.errors.push({ filePath: data.filePath, error: error instanceof Error ? error.message : String(error) });
      sdk.logger.error(`Failed to finalize ${data.filePath}:`, error);
    }
  }
}
