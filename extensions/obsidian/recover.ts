import { statSync } from "node:fs";
import { getSDK, logger, type ShaleSDK, type CheckpointContext } from "@shale/sdk";
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
  const vaultMaxMtime = new Map<string, { path: string; maxMtime: number }>();

  for (const cp of context.checkpoints) {
    const data = cp.data;
    if (!data || data.type !== "ai_summary" || !data.parsedFile) {
      // Not a full note AI summary checkpoint, resolve and continue
      context.resolve(cp.id);
      continue;
    }

    const {
      vault,
      parsedFile,
      entities = [],
      edges = [],
      mtime = 0,
      filePath,
    } = data;

    try {
      sdk.logger.log(
        `[Recovery] Finalizing note "${parsedFile.noteTitle}" with cached AI summary...`,
      );

      // Embed the contextual chunks (which include the AI summary expansion)
      const embeddings = await embedContextualChunks(
        sdk,
        parsedFile.contextualChunks,
        parsedFile.noteTitle,
      );

      // Commit note source and chunks to SQLite
      sdk.ingest.sourceAndChunks({
        source: {
          type: "markdown_note",
          uri: parsedFile.noteUri,
          origin: "obsidian",
          title: parsedFile.noteTitle,
          updated_at: parsedFile.updatedAt,
        },
        chunks: parsedFile.contextualChunks.map(
          (chunk: any, idx: number) => ({
            chunk_index: chunk.chunk_index,
            chunk_type:
              chunk.chunk_type ??
              (chunk.heading?.includes("(Expanded Context)")
                ? "synthetic"
                : "verbatim"),
            text_content: chunk.text_content,
            embedding: embeddings[idx],
          }),
        ),
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
      let resolvedMtime = mtime;
      if (filePath) {
        try {
          resolvedMtime = Math.max(resolvedMtime, statSync(filePath).mtimeMs);
        } catch {}
      }

      if (vault?.path && resolvedMtime > 0) {
        const current = vaultMaxMtime.get(vault.path)?.maxMtime ?? 0;
        if (resolvedMtime > current) {
          vaultMaxMtime.set(vault.path, {
            path: vault.path,
            maxMtime: resolvedMtime,
          });
        }
      }

      recoveredNotes++;
      context.resolve(cp.id);
      sdk.logger.log(
        `[Recovery] Successfully recovered note "${parsedFile.noteTitle}".`,
      );
    } catch (err) {
      sdk.logger.error(
        `[Recovery] Failed to recover checkpoint for note "${data.noteTitle}":`,
        err,
      );
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
