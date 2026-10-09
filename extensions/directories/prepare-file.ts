import type { ShaleSDK } from "@shale/sdk";
import type { DirectorySettings } from "./settings.types";
import type { DirectoryInfo, DirectoryResult, PendingDirectoryFile, PreparedDirectoryFile } from "./types";
import { fileVersion } from "./scan";
import { checkpointId, fileStateKey } from "./file-state";

/** Prepare and checkpoint one file before its transactional commit. */
export async function prepareDirectoryFile(
  sdk: ShaleSDK, settings: DirectorySettings, force: boolean, namespace: string,
  directory: DirectoryInfo, result: DirectoryResult, filePath: string,
): Promise<PendingDirectoryFile | null> {
  try {
    const version = await fileVersion(filePath);
    if (!force && sdk.state.getWatermark(fileStateKey(namespace, filePath)) === version.fingerprint) {
      result.filesSkipped++;
      return null;
    }
    if (version.size > (settings.maxFileSizeMB ?? 50) * 1024 * 1024) {
      throw new Error("File exceeds maxFileSizeMB");
    }
    const id = checkpointId(sdk, namespace, filePath);
    const cached = sdk.checkpoint.get<PreparedDirectoryFile>(id);
    if (!force && cached?.data.type === "directory_file" && cached.data.fingerprint === version.fingerprint) {
      return { id, data: cached.data, result };
    }
    const capability = await sdk.messages.request("file:can-process", { filePath });
    if (!capability.canProcess) {
      result.filesSkipped++;
      return null;
    }
    const parsed = await sdk.messages.request("file:process", {
      filePath,
      options: { namespace, timeoutMs: settings.processingTimeoutMs ?? 120000 },
    }, { target: capability.supportedBy, timeoutMs: settings.processingTimeoutMs ?? 120000 });
    if (!parsed.success || !parsed.chunks.length) throw new Error(parsed.error ?? "Processor returned no chunks");
    if ((await fileVersion(filePath)).fingerprint !== version.fingerprint) {
      throw new Error("File changed while processing; it will be retried on the next scan");
    }
    // Keep canonical local identity regardless of processor URI formatting.
    const data: PreparedDirectoryFile = { type: "directory_file", directory, filePath, namespace,
      fingerprint: version.fingerprint, updatedAt: version.updatedAt,
      parsed: { ...parsed, chunks: parsed.chunks.map((chunk, chunk_index) => ({ ...chunk, chunk_index })) } };
    sdk.saveCheckpoint(data, { id, key: id });
    return { id, data, result };
  } catch (error) {
    result.errors.push({ filePath, error: error instanceof Error ? error.message : String(error) });
    sdk.logger.error(`Failed to prepare ${filePath}:`, error);
  }
  return null;
}
