import type { ShaleSDK } from "@shale/sdk";
import { pathToFileURL } from "node:url";
import { commitFile } from "./commit";
import { fileVersion } from "./scan";
import type { PendingDirectoryFile } from "./types";

/** Phase 2 never invokes a parser or chat model. Failed files remain checkpointed. */
export async function finalizeFiles(sdk: ShaleSDK, files: PendingDirectoryFile[]) {
  const batchSize = sdk.settings.get<number>("embeddingBatchSize") ?? 64;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("embeddingBatchSize must be a positive integer");
  for (const { id, data, result } of files) {
    try {
      if ((await fileVersion(data.filePath)).fingerprint !== data.fingerprint) {
        throw new Error("File changed after preparation; it will be retried on the next scan");
      }
      const embeddings: number[][] = [];
      for (let start = 0; start < data.parsed.chunks.length; start += batchSize) {
        const chunks = data.parsed.chunks.slice(start, start + batchSize);
        const vectors = await sdk.embed(chunks.map(chunk => chunk.text_content));
        if (vectors.length !== chunks.length || vectors.some(vector => !vector?.length || vector.some(value => !Number.isFinite(value)))) {
          throw new Error("Embedding response did not contain a valid vector for every chunk");
        }
        embeddings.push(...vectors);
      }
      if ((await fileVersion(data.filePath)).fingerprint !== data.fingerprint) throw new Error("File changed during embedding; retry required");
      const committed = commitFile(sdk, id, data, embeddings);
      result.filesProcessed++;
      result.chunksCreated += committed.chunksCount;
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
