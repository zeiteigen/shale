import { getSDK, type ShaleSDK, type CheckpointContext } from "@shale/sdk";
import { fileVersion } from "./scan";
import { finalizeFiles } from "./finalize";
import { withDirectoryRun } from "./run-lock";
import type { DirectoryResult, PendingDirectoryFile, PreparedDirectoryFile } from "./types";

export async function run(sdkOverride?: ShaleSDK, contextOverride?: CheckpointContext<PreparedDirectoryFile>) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const context = contextOverride ?? sdk.getCheckpointContext<PreparedDirectoryFile>();
  return withDirectoryRun(sdk, () => sdk.models.phase("embedding", async () => {
    const result: DirectoryResult = { directory: "recovery", filesProcessed: 0, filesSkipped: 0, chunksCreated: 0, errors: [] };
    const pending: PendingDirectoryFile[] = [];
    for (const checkpoint of context.checkpoints) {
      const data = checkpoint.data;
      if (data?.type !== "directory_file") continue;
      try {
        if ((await fileVersion(data.filePath)).fingerprint !== data.fingerprint) {
          context.resolve(checkpoint.id);
          result.filesSkipped++;
          continue;
        }
        pending.push({ id: checkpoint.id, data, result });
      } catch (error) {
        if (["ENOENT", "ENOTDIR", "ENOTFILE"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          context.resolve(checkpoint.id);
          result.filesSkipped++;
        } else throw error;
      }
    }
    await finalizeFiles(sdk, pending);
    if (result.errors.length) throw new Error(`Directory recovery failed for ${result.errors.length} file(s)`);
    return { recoveredFiles: result.filesProcessed, discardedFiles: result.filesSkipped };
  }));
}

if (import.meta.main) {
  run().catch(error => { console.error("Directory recovery failed:", error); process.exitCode = 1; });
}

export default run;
