import { getSDK, logger, type ShaleSDK } from "@shale/sdk";
import { discoverVaults } from "./vault-finder";

import {
  processVault,
  prepareVault,
  finalizeVault,
  ingestFile,
  ingestImageFile,
  parseFile,
  parseImageFile,
  parseImageFilesBatch,
  findImageFiles,
  findMarkdownFiles,
  findDocumentFiles,
  parseDocumentFile,
  type ParsedDocument,
  expandNoteWithChatModel,
  describeImageWithChatModel,
  type ProcessVaultResult,
  type PreparedVault,
  type IngestFileResult,
  type IngestImageResult,
  type ParsedFile,
  type ParsedImage,
} from "./process-vaults";

import { run as recover, type RecoverResult } from "./recover";

export {
  processVault,
  prepareVault,
  finalizeVault,
  recover,
  type RecoverResult,
  ingestFile,
  ingestImageFile,
  parseFile,
  parseImageFile,
  parseImageFilesBatch,
  findImageFiles,
  findMarkdownFiles,
  findDocumentFiles,
  parseDocumentFile,
  type ParsedDocument,
  expandNoteWithChatModel,
  describeImageWithChatModel,
  type ProcessVaultResult,
  type PreparedVault,
  type IngestFileResult,
  type IngestImageResult,
  type ParsedFile,
  type ParsedImage,
};

/**
 * Main extension runner invoked on cron schedule or standalone.
 * Enforces a strict two-phase pipeline across all vaults:
 * Phase 1: All Chat model work (summaries, expansions, multimodal image descriptions).
 * Phase 2: All Embedding model work (batch embeddings, chunk storage, graph edges).
 * This prevents local model servers from repeatedly swapping chat and embedding models in VRAM.
 */
export async function run(
  sdkOverride?: ShaleSDK,
  configPath?: string,
  forceAll?: boolean,
): Promise<ProcessVaultResult[]> {
  const sdk = sdkOverride ?? getSDK();

  const isForce = forceAll ?? sdk.settings.get<boolean>("forceAll") ?? false;

  const vaults = discoverVaults(configPath, sdk);

  if (vaults.length === 0) {
    sdk.logger.log("No active vaults found in obsidian.json.");
    return [];
  }

  if (isForce) {
    sdk.logger.log("Force processing all vaults (ignoring watermarks).");
  }

  sdk.logger.log(`Discovered ${vaults.length} vault(s).`);

  return sdk.models.batch(
    async () => {
      const preparedVaults: PreparedVault[] = [];
      for (const vault of vaults)
        preparedVaults.push(await prepareVault(vault, sdk, isForce));
      return preparedVaults;
    },
    async (preparedVaults) => {
      const results: ProcessVaultResult[] = [];
      for (const prepared of preparedVaults)
        results.push(await finalizeVault(prepared, sdk));
      return results;
    },
  );
}

// Standalone execution support
if (import.meta.main) {
  run().catch((err) => {
    logger.error("Fatal error running obsidian plugin:", err);
  });
}

export default run;
