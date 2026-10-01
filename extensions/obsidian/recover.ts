import {
  getSDK,
  logger,
  type ShaleSDK,
  type CheckpointContext,
} from "@shale/sdk";
import { embedContextualChunks, commitVaultGraph } from "./process-vaults";

export interface RecoverResult {
  recoveredNotes: number;
}

/**
 * Checkpoint recovery script for the Obsidian extension.
 * Invoked automatically by Shale when queued checkpoints are detected.
 *
 * Finalizes notes that had their AI summaries/expansions generated before a crash:
 * 1. Retrieves queued checkpoints via SDK context.
 * 2. Embeds contextual chunks (including the AI summary).
 * 3. Commits markdown_note sources, chunks, and graph edges to SQLite.
 * 4. Advances the vault watermark so subsequent cron runs skip recovered files.
 * 5. Resolves each processed checkpoint.
 */
export async function run(
  sdkOverride?: ShaleSDK,
  contextOverride?: CheckpointContext,
): Promise<RecoverResult> {
  const sdk = sdkOverride ?? getSDK();
  const context = contextOverride ?? sdk.getCheckpointContext();

  if (!context || context.count === 0) {
    sdk.logger.log("[Recovery] No queued checkpoints to recover.");
    return { recoveredNotes: 0 };
  }

  sdk.logger.log(
    `[Recovery] Found ${context.count} queued checkpoint(s). Beginning AI summary recovery...`,
  );

  let recoveredNotes = 0;
  let failures = 0;
  const batches = context.checkpoints.filter(
    (cp) => cp.data?.type === "vault_batch",
  );
  const vaultMaxMtime = new Map<string, { path: string; maxMtime: number }>();

  for (const cp of context.checkpoints) {
    const data = cp.data;
    if (data?.type === "vault_batch") continue;
    if (
      !data ||
      !["ai_summary", "image_analysis"].includes(data.type) ||
      !(data.parsedFile || data.parsedImage)
    ) {
      // Not a full note AI summary checkpoint, resolve and continue
      context.resolve(cp.id);
      continue;
    }

    const {
      vault,
      parsedFile,
      entities = [],
      edges = [],
    } = data;

    try {
      const parsed = parsedFile ?? data.parsedImage;
      sdk.logger.log(
        `[Recovery] Finalizing note "${parsed.noteTitle ?? parsed.imageTitle}" with cached AI summary...`,
      );

      // Embed the contextual chunks (which include the AI summary expansion)
      const embeddings = await embedContextualChunks(
        sdk,
        parsed.contextualChunks,
        parsed.noteTitle ?? parsed.imageTitle,
      );

      // Commit note source and chunks to SQLite
      sdk.ingest.sourceAndChunks({
        source: {
          type: parsedFile ? "markdown_note" : "image",
          uri: parsed.noteUri ?? parsed.imageUri,
          origin: "obsidian",
          title: parsed.noteTitle ?? parsed.imageTitle,
          updated_at: parsed.updatedAt,
        },
        chunks: parsed.contextualChunks.map((chunk: any, idx: number) => ({
          chunk_index: chunk.chunk_index,
          chunk_type:
            chunk.chunk_type ??
            (chunk.heading?.includes("(Expanded Context)")
              ? "synthetic"
              : "verbatim"),
          text_content: chunk.text_content,
          embedding: embeddings[idx],
        })),
        namespace: "obsidian",
      });

      // Commit graph elements
      const vaultEntityName = vault?.name ? `Vault: ${vault.name}` : undefined;
      const allEntities = [
        ...(vaultEntityName ? [{ name: vaultEntityName, type: "Vault" }] : []),
        ...entities,
      ];
      if (allEntities.length > 0 && edges.length > 0) {
        commitVaultGraph(sdk, allEntities, edges);
      }

      // Track watermark advancement for this vault

      // Individual checkpoints do not prove that the discovery batch finished.
      // Without its batch record, retain the old watermark and rescan the vault.

      recoveredNotes++;
      context.resolve(cp.id);
      sdk.logger.log(
        `[Recovery] Successfully recovered note "${parsed.noteTitle ?? parsed.imageTitle}".`,
      );
    } catch (err) {
      failures++;
      sdk.logger.error(
        `[Recovery] Failed to recover checkpoint for note "${data.noteTitle}":`,
        err,
      );
    }
  }

  if (failures)
    throw new Error(`Obsidian recovery failed for ${failures} checkpoint(s)`);

  for (const batch of batches) {
    if (!batch.data.preparationFailed) {
      vaultMaxMtime.set(batch.data.vault.path, {
        path: batch.data.vault.path,
        maxMtime: batch.data.maxMtime,
      });
    }
  }

  // Advance watermarks for all recovered vaults
  for (const [vaultPath, { maxMtime }] of vaultMaxMtime.entries()) {
    const watermarkKey = `vault:${vaultPath}:mtime`;
    const lastWatermark = Number(sdk.state.getWatermark(watermarkKey) ?? "0");
    if (maxMtime > lastWatermark) {
      sdk.state.setWatermark(String(maxMtime), watermarkKey);
      sdk.logger.log(
        `[Recovery] Advanced watermark for vault at "${vaultPath}" to ${maxMtime}.`,
      );
    }
  }

  for (const batch of batches) context.resolve(batch.id);

  sdk.logger.log(
    `[Recovery] Checkpoint recovery finished. Recovered ${recoveredNotes} note(s).`,
  );

  return { recoveredNotes };
}

if (import.meta.main) {
  run().catch((err) => {
    logger.error("Fatal error during obsidian checkpoint recovery:", err);
  });
}

export default run;
