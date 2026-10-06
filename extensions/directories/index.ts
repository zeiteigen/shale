import { getSDK } from "@shale/sdk";
import type { ShaleSDK } from "@shale/sdk";
import { prepareDirectories } from "./prepare";
import { finalizeFiles } from "./finalize";
import { withDirectoryRun } from "./run-lock";
import { DEFAULT_FILE_EXTENSIONS, type DirectorySettings } from "./settings.types";
export type { DirectoryResult } from "./types";
export { run as recover } from "./recover";

/** Finish chat/vision processing across every selected root before embedding. */
export async function run(sdkOverride?: ShaleSDK, forceAll?: boolean) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const settings = sdk.settings.getAll<DirectorySettings>();
  settings.fileExtensions ??= DEFAULT_FILE_EXTENSIONS;
  if (!settings.directories?.length) {
    sdk.logger.log("No directories selected. Set directories in extensions/directories/settings.json.");
    return [];
  }
  return withDirectoryRun(sdk, () => sdk.models.batch(
    () => prepareDirectories(sdk, settings, forceAll ?? settings.forceAll ?? false),
    async ({ results, pending }) => {
      await finalizeFiles(sdk, pending);
      for (const result of results) sdk.logger.log(`${result.directory}: ${result.filesProcessed} file(s) ingested, ${result.filesSkipped} skipped, ${result.errors.length} error(s).`);
      return results;
    },
  ));
}

if (import.meta.main) {
  run().catch(error => { console.error("Directory ingestion failed:", error); process.exitCode = 1; });
}

export default run;
