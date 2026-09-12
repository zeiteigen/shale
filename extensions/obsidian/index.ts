import { getSDK, type ShaleSDK } from "@shale/sdk";
import { discoverVaults } from "./vault-finder";

import {
  processVault,
  ingestFile,
  ingestImageFile,
  parseFile,
  parseImageFile,
  findImageFiles,
  findMarkdownFiles,
  type ProcessVaultResult,
  type IngestFileResult,
  type IngestImageResult,
  type ParsedFile,
  type ParsedImage,
} from "./process-vaults";

export {
  processVault,
  ingestFile,
  ingestImageFile,
  parseFile,
  parseImageFile,
  findImageFiles,
  findMarkdownFiles,
  type ProcessVaultResult,
  type IngestFileResult,
  type IngestImageResult,
  type ParsedFile,
  type ParsedImage,
};

/**
 * Main extension runner invoked on cron schedule or standalone.
 */
export async function run(
  sdkOverride?: ShaleSDK,
  configPath?: string,
  forceAll: boolean = process.argv.includes("--run-all-cron"),
): Promise<ProcessVaultResult[]> {
  const sdk = sdkOverride ?? getSDK();

  const vaults = discoverVaults(configPath);

  if (vaults.length === 0) {
    console.log("[Obsidian] No active vaults found in obsidian.json.");
    return [];
  }

  if (forceAll) {
    console.log(
      "[Obsidian] Force processing all vaults (ignoring watermarks).",
    );
  }

  console.log(`[Obsidian] Discovered ${vaults.length} vault(s).`);

  const results: ProcessVaultResult[] = [];
  for (const vault of vaults) {
    const result = await processVault(vault, sdk, forceAll);
    results.push(result);
  }

  return results;
}

// Standalone execution support
if (import.meta.main) {
  run().catch((err) => {
    console.error("[Obsidian] Fatal error running obsidian plugin:", err);
  });
}

export default run;
