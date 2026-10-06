import {
  getSDK,
  logger,
  type ShaleSDK,
  type CheckpointContext,
} from "@shale/sdk";
import { commitNote, commitImage } from "./commit";
import { embedContextualChunks } from "./process-vaults";
import { documentWatermarkKey, finalizeDocument } from "./document-vault";

export interface RecoverResult {
  recoveredNotes: number;
  recoveredDocuments: number;
}

/**
 * Checkpoint recovery script for the Obsidian extension.
 * Invoked automatically by Shale when queued checkpoints are detected.
 *
 * Finalizes cached note, image, and document preparation from before a crash:
 * 1. Retrieves queued checkpoints via SDK context.
 * 2. Embeds contextual chunks (including the AI summary).
 * 3. Commits sources, chunks, and graph evidence to SQLite.
 * 4. Advances each vault's cursors only when its discovery batch completed.
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
    return { recoveredNotes: 0, recoveredDocuments: 0 };
  }

  sdk.logger.log(
    `[Recovery] Found ${context.count} queued checkpoint(s). Beginning vault recovery...`,
  );

  let recoveredNotes = 0;
  let recoveredDocuments = 0;
  let failures = 0;
  const batches = context.checkpoints.filter(
    (cp) => cp.data?.type === "vault_batch",
  );
  const vaultMaxMtime = new Map<string, { path: string; maxMtime: number; maxDocumentMtime?: number }>();

  for (const cp of context.checkpoints) {
    const data = cp.data;
    if (data?.type === "vault_batch") continue;
    if (
      !data ||
      !["ai_summary", "image_analysis", "document_analysis"].includes(data.type) ||
      !(data.parsedFile || data.parsedImage || data.parsedDocument)
    ) {
      // Not a complete file preparation checkpoint, resolve and continue.
      context.resolve(cp.id);
      continue;
    }

    const {vault,parsedFile} = data;

    try {
      if (data.type === "document_analysis") {
        const namespace = data.namespace ?? sdk.settings.get<string>("namespace") ?? sdk.namespace ?? "obsidian";
        await finalizeDocument(data.parsedDocument, vault, sdk, namespace, cp.id);
        recoveredDocuments++;
        context.resolve(cp.id);
        sdk.logger.log(`[Recovery] Recovered document "${data.parsedDocument.documentTitle}".`);
        continue;
      }
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

      const vaultContext = vault ?? {name:"Vault",path:parsed.filePath.substring(0,parsed.filePath.lastIndexOf("/"))};
      const namespace = data.namespace ?? sdk.settings.get<string>("namespace") ?? sdk.namespace ?? "obsidian";
      if (parsedFile) commitNote(sdk,parsedFile,embeddings,vaultContext,namespace,cp.id);
      else commitImage(sdk,data.parsedImage,embeddings,vaultContext,namespace,cp.id);

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
        `[Recovery] Failed to recover checkpoint for "${data.noteTitle ?? data.parsedDocument?.documentTitle ?? data.filePath}":`,
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
        maxDocumentMtime: batch.data.maxDocumentMtime,
      });
    }
  }

  // Advance watermarks for all recovered vaults
  for (const [vaultPath, { maxMtime, maxDocumentMtime }] of vaultMaxMtime.entries()) {
    const watermarkKey = `vault:${vaultPath}:mtime`;
    const lastWatermark = Number(sdk.state.getWatermark(watermarkKey) ?? "0");
    if (maxMtime > lastWatermark) {
      sdk.state.setWatermark(String(maxMtime), watermarkKey);
      sdk.logger.log(
        `[Recovery] Advanced watermark for vault at "${vaultPath}" to ${maxMtime}.`,
      );
    }
    if (maxDocumentMtime !== undefined) {
      const documentKey = documentWatermarkKey(vaultPath);
      const lastDocumentMtime = Number(sdk.state.getWatermark(documentKey) ?? "0");
      if (maxDocumentMtime > lastDocumentMtime) sdk.state.setWatermark(String(maxDocumentMtime), documentKey);
    }
  }

  for (const batch of batches) context.resolve(batch.id);

  sdk.logger.log(
    `[Recovery] Checkpoint recovery finished. Recovered ${recoveredNotes} note(s) and ${recoveredDocuments} document(s).`,
  );

  return { recoveredNotes, recoveredDocuments };
}

if (import.meta.main) {
  run().catch((err) => {
    logger.error("Fatal error during obsidian checkpoint recovery:", err);
  });
}

export default run;
