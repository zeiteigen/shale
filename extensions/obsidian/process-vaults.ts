import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { getSDK, logger, getSetting, type ShaleSDK } from "@shale/sdk";
import { type VaultInfo } from "./vault-finder";
import { isImageFile } from "./parser";
import {
  parseFile,
  buildContextualChunks,
  expandNoteWithChatModel,
  type ParsedFile,
  type ContextualChunk,
  type ParseFileOptions,
} from "./parse-file";
import {
  parseImageFile,
  parseImageFilesBatch,
  describeImageWithChatModel,
  type ParsedImage,
} from "./parse-image";
import {
  ingestFile,
  ingestImageFile,
  embedContextualChunks,
  buildNoteGraphElements,
  type IngestFileResult,
  type IngestImageResult,
  type NoteGraphElements,
  type IngestFileOptions,
} from "./ingest-file";

export interface ProcessVaultResult {
  vaultName: string;
  notesProcessed: number;
  imagesProcessed: number;
  chunksCreated: number;
  edgesCreated: number;
  watermarkAdvancedTo: number;
}

// Re-export file parsing and ingestion primitives for convenient access
export {
  parseFile,
  parseImageFile,
  parseImageFilesBatch,
  buildContextualChunks,
  expandNoteWithChatModel,
  describeImageWithChatModel,
  type ParsedFile,
  type ParsedImage,
  type ContextualChunk,
  type ParseFileOptions,
};
export {
  ingestFile,
  ingestImageFile,
  embedContextualChunks,
  buildNoteGraphElements,
  type IngestFileResult,
  type IngestImageResult,
  type NoteGraphElements,
  type IngestFileOptions,
};

/**
 * Commits deduplicated entities and edges to the graph.
 */
export function commitVaultGraph(
  sdk: ShaleSDK,
  entities: Array<{ name: string; type: string }>,
  edges: Array<{ source: string; target: string; relation: string }>,
): number {
  const deduplicatedEntities = Array.from(
    new Map(entities.map((e) => [e.name, e])).values(),
  );

  if (deduplicatedEntities.length > 0 && edges.length > 0) {
    const graphRes = sdk.graph.ingest({
      namespace: "obsidian",
      entities: deduplicatedEntities,
      edges,
    });
    return graphRes.edgesInserted;
  }

  return 0;
}

/**
 * Recursively discovers all markdown files within a directory, ignoring hidden and configured directories.
 */
export function findMarkdownFiles(
  dir: string,
  baseDir: string = dir,
  ignoredDirs?: string[],
): string[] {
  const files: string[] = [];
  const ignoredList =
    ignoredDirs ?? getSetting<string[]>("ignoredDirectories") ?? [];
  const ignoredSet = new Set(ignoredList.map((d) => d.toLowerCase()));

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Ignore hidden directories (.obsidian, .git, .trash) and configured ignored directories
      if (
        entry.name.startsWith(".") ||
        ignoredSet.has(entry.name.toLowerCase())
      ) {
        continue;
      }

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        files.push(...findMarkdownFiles(fullPath, baseDir, ignoredDirs));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(fullPath);
      }
    }
  } catch (err) {
    logger.warn(`Error scanning directory ${dir}:`, err);
  }

  return files;
}

/**
 * Recursively discovers all image files within a directory, ignoring hidden and configured directories.
 */
export function findImageFiles(
  dir: string,
  baseDir: string = dir,
  ignoredDirs?: string[],
): string[] {
  const files: string[] = [];
  const ignoredList =
    ignoredDirs ?? getSetting<string[]>("ignoredDirectories") ?? [];
  const ignoredSet = new Set(ignoredList.map((d) => d.toLowerCase()));

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        ignoredSet.has(entry.name.toLowerCase())
      ) {
        continue;
      }

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        files.push(...findImageFiles(fullPath, baseDir, ignoredDirs));
      } else if (entry.isFile() && isImageFile(entry.name)) {
        files.push(fullPath);
      }
    }
  } catch (err) {
    logger.warn(`Error scanning directory ${dir} for images:`, err);
  }

  return files;
}

/**
 * Filters files modified since the last watermark timestamp and computes the updated max watermark.
 */
export function filterModifiedFiles(
  filePaths: string[],
  lastWatermark: number,
): { modifiedFiles: string[]; maxMtime: number } {
  let maxMtime = lastWatermark;

  const modifiedFiles = filePaths.filter((file) => {
    try {
      const stats = statSync(file);
      const mtime = stats.mtimeMs;
      if (mtime > maxMtime) {
        maxMtime = mtime;
      }
      return mtime > lastWatermark;
    } catch {
      return false;
    }
  });

  return { modifiedFiles, maxMtime };
}

/**
 * Processes an individual Obsidian vault using the Shale SDK:
 * 1. Discovers and filters modified markdown notes and images.
 */
export interface PreparedVault {
  checkpointId?: string;
  vault: VaultInfo;
  maxMtime: number;
  preparationFailed?: boolean;
  vaultEntityName: string;
  entities: Array<{ name: string; type: string }>;
  edges: Array<{ source: string; target: string; relation: string }>;
  parsedNotes: Array<{
    filePath: string;
    parsedFile: ParsedFile;
    entities: Array<{ name: string; type: string }>;
    edges: Array<{ source: string; target: string; relation: string }>;
  }>;
  parsedImages: Array<{
    filePath: string;
    parsedImage: ParsedImage;
    entities: Array<{ name: string; type: string }>;
    edges: Array<{ source: string; target: string; relation: string }>;
  }>;
}

/**
 * Phase 1: Discovers modified notes and images and executes all Chat model operations
 * (summaries, note content expansion, multimodal image descriptions).
 * Zero embedding calls happen in this phase, keeping the Chat model loaded in GPU memory.
 */
export async function prepareVault(
  vault: VaultInfo,
  sdkOverride?: ShaleSDK,
  forceAll: boolean = false,
): Promise<PreparedVault> {
  const sdk = sdkOverride ?? getSDK();

  const force =
    forceAll ||
    sdk.settings.get<boolean>("forceAll") ||
    getSetting<boolean>("forceAll", false);

  const watermarkKey = `vault:${vault.path}:mtime`;
  const lastWatermark = force
    ? 0
    : Number(sdk.state.getWatermark(watermarkKey) ?? "0");

  sdk.logger.log(
    `[Phase 1: Chat Model] Inspecting vault "${vault.name}" (last watermark: ${lastWatermark})`,
  );

  const includeMarkdown =
    sdk.settings.get<boolean>("includeMarkdown") ??
    getSetting<boolean>("includeMarkdown", true);
  const includeImages =
    sdk.settings.get<boolean>("includeImages") ??
    getSetting<boolean>("includeImages", true);
  const ignoredDirectories =
    sdk.settings.get<string[]>("ignoredDirectories") ??
    getSetting<string[]>("ignoredDirectories");

  const allMdFiles = includeMarkdown
    ? findMarkdownFiles(vault.path, vault.path, ignoredDirectories)
    : [];
  const allImageFiles = includeImages
    ? findImageFiles(vault.path, vault.path, ignoredDirectories)
    : [];

  const { modifiedFiles: modifiedNotes, maxMtime: maxNoteMtime } =
    filterModifiedFiles(allMdFiles, lastWatermark);
  const { modifiedFiles: modifiedImages, maxMtime: maxImageMtime } =
    filterModifiedFiles(allImageFiles, lastWatermark);

  const maxMtime = Math.max(maxNoteMtime, maxImageMtime);
  const vaultEntityName = `Vault: ${vault.name}`;

  const prepared: PreparedVault = {
    vault,
    maxMtime,
    vaultEntityName,
    entities: [{ name: vaultEntityName, type: "Vault" }],
    edges: [],
    parsedNotes: [],
    parsedImages: [],
  };

  if (modifiedNotes.length === 0 && modifiedImages.length === 0) {
    sdk.logger.log(`Vault "${vault.name}" has no updates since last run.`);
    return prepared;
  }

  sdk.logger.log(
    `[Phase 1: Chat Model] Processing ${modifiedNotes.length} updated note(s) and ${modifiedImages.length} updated image(s) with Chat model in "${vault.name}"...`,
  );

  // 1. Process modified notes via ingestFile with deferEmbedding: true (calls parseFile & Chat model expansion)
  for (const filePath of modifiedNotes) {
    try {
      const fileResult = await ingestFile(filePath, vaultEntityName, sdk, {
        deferEmbedding: true,
      });
      if (fileResult.parsedFile) {
        prepared.parsedNotes.push({
          filePath,
          parsedFile: fileResult.parsedFile,
          entities: fileResult.entities,
          edges: fileResult.edges,
        });

        sdk.saveCheckpoint(
          {
            type: "ai_summary",
            vault: { name: vault.name, path: vault.path },
            filePath,
            noteTitle: fileResult.parsedFile.noteTitle,
            parsedFile: fileResult.parsedFile,
            entities: [
              { name: vaultEntityName, type: "Vault" },
              ...fileResult.entities,
            ],
            edges: fileResult.edges,
            mtime: statSync(filePath).mtimeMs,
          },
          { id: `ai_summary:${filePath}`, key: `ai_summary:${filePath}` },
        );
      }
    } catch (noteErr) {
      prepared.preparationFailed = true;
      sdk.logger.error(`Failed to process note at ${filePath}:`, noteErr);
    }
  }

  // 2. Process modified images via bulk parsing with deferEmbedding: true
  if (modifiedImages.length > 0) {
    try {
      const parsedBatch = await parseImageFilesBatch(modifiedImages, sdk);
      for (const parsedImage of parsedBatch) {
        prepared.parsedImages.push({
          filePath: parsedImage.filePath,
          parsedImage,
          entities: [{ name: parsedImage.imageTitle, type: "Image" }],
          edges: [
            {
              source: parsedImage.imageTitle,
              target: vaultEntityName,
              relation: "IN_SAME_VAULT",
            },
          ],
        });
      }
    } catch (batchErr) {
      sdk.logger.error(
        `Failed to batch parse images in "${vault.name}":`,
        batchErr,
      );
      for (const imagePath of modifiedImages) {
        try {
          const imageResult = await ingestImageFile(
            imagePath,
            vaultEntityName,
            sdk,
            { deferEmbedding: true },
          );
          if (imageResult.parsedImage) {
            prepared.parsedImages.push({
              filePath: imagePath,
              parsedImage: imageResult.parsedImage,
              entities: imageResult.entities,
              edges: imageResult.edges,
            });
          }
        } catch (imgErr) {
          prepared.preparationFailed = true;
          sdk.logger.error(`Failed to process image at ${imagePath}:`, imgErr);
        }
      }
    }
  }

  if (prepared.parsedImages.length !== modifiedImages.length)
    prepared.preparationFailed = true;
  for (const image of prepared.parsedImages) {
    sdk.saveCheckpoint(
      {
        type: "image_analysis",
        vault: { name: vault.name, path: vault.path },
        filePath: image.filePath,
        parsedImage: image.parsedImage,
        entities: image.entities,
        edges: image.edges,
        mtime: statSync(image.filePath).mtimeMs,
      },
      {
        id: `image_analysis:${image.filePath}`,
        key: `image_analysis:${image.filePath}`,
      },
    );
  }

  prepared.checkpointId = `vault_batch:${vault.path}`;
  sdk.saveCheckpoint(
    {
      type: "vault_batch",
      vault: { name: vault.name, path: vault.path },
      maxMtime,
      preparationFailed: prepared.preparationFailed ?? false,
    },
    { id: prepared.checkpointId, key: prepared.checkpointId },
  );

  sdk.logger.log(
    `[Phase 1: Chat Model] Finished Chat model operations for "${vault.name}" (${prepared.parsedNotes.length} note(s), ${prepared.parsedImages.length} image(s)).`,
  );

  return prepared;
}

/**
 * Phase 2: Embeds all prepared chunks using the Embedding model and commits sources,
 * chunks, and graph edges to SQLite. Zero Chat model calls happen in this phase,
 * keeping the Embedding model loaded in GPU memory without switching back and forth.
 */
export async function finalizeVault(
  prepared: PreparedVault,
  sdkOverride?: ShaleSDK,
): Promise<ProcessVaultResult> {
  const sdk = sdkOverride ?? getSDK();

  if (prepared.parsedNotes.length === 0 && prepared.parsedImages.length === 0) {
    if (prepared.preparationFailed)
      throw new Error("Vault preparation failed; watermark retained for retry");
    return {
      vaultName: prepared.vault.name,
      notesProcessed: 0,
      imagesProcessed: 0,
      chunksCreated: 0,
      edgesCreated: 0,
      watermarkAdvancedTo: prepared.maxMtime,
    };
  }

  sdk.logger.log(
    `[Phase 2: Embedding Model] Embedding and ingesting ${prepared.parsedNotes.length} note(s) and ${prepared.parsedImages.length} image(s) for "${prepared.vault.name}"...`,
  );

  let totalChunksCreated = 0;
  let notesProcessed = 0;
  let imagesProcessed = 0;
  let failures = prepared.preparationFailed ? 1 : 0;
  const resolvedCheckpoints: string[] = [];

  const entities: Array<{ name: string; type: string }> = [
    ...prepared.entities,
  ];
  const edges: Array<{ source: string; target: string; relation: string }> = [
    ...prepared.edges,
  ];

  // 1. Embed and ingest all parsed notes
  for (const note of prepared.parsedNotes) {
    try {
      const embeddings = await embedContextualChunks(
        sdk,
        note.parsedFile.contextualChunks,
        note.parsedFile.noteTitle,
      );

      const ingestResult = sdk.ingest.sourceAndChunks({
        source: {
          type: "markdown_note",
          uri: note.parsedFile.noteUri,
          origin: "obsidian",
          title: note.parsedFile.noteTitle,
          updated_at: note.parsedFile.updatedAt,
        },
        chunks: note.parsedFile.contextualChunks.map((chunk, idx) => ({
          chunk_index: chunk.chunk_index,
          chunk_type: chunk.chunk_type ?? "verbatim",
          text_content: chunk.text_content,
          embedding: embeddings[idx],
        })),
        namespace: "obsidian",
      });

      totalChunksCreated += ingestResult.chunksCount;
      entities.push(...note.entities);
      edges.push(...note.edges);
      notesProcessed++;

      resolvedCheckpoints.push(`ai_summary:${note.filePath}`);
    } catch (err) {
      failures++;
      sdk.logger.error(
        `Failed to embed and ingest note at ${note.filePath}:`,
        err,
      );
    }
  }

  // 2. Embed and ingest all parsed images
  for (const img of prepared.parsedImages) {
    try {
      const targetChunks =
        img.parsedImage.contextualChunks &&
        img.parsedImage.contextualChunks.length > 0
          ? img.parsedImage.contextualChunks
          : [img.parsedImage.contextualChunk];

      const embeddings = await embedContextualChunks(
        sdk,
        targetChunks,
        img.parsedImage.imageTitle,
      );

      const ingestResult = sdk.ingest.sourceAndChunks({
        source: {
          type: "image",
          uri: img.parsedImage.imageUri,
          origin: "obsidian",
          title: img.parsedImage.imageTitle,
          updated_at: img.parsedImage.updatedAt,
        },
        chunks: targetChunks.map((chunk, idx) => ({
          chunk_index: chunk.chunk_index,
          chunk_type:
            chunk.chunk_type ??
            (chunk.chunk_index === 0 ? "verbatim" : "synthetic"),
          text_content: chunk.text_content,
          embedding: embeddings[idx],
        })),
        namespace: "obsidian",
      });

      totalChunksCreated += ingestResult.chunksCount;
      entities.push(...img.entities);
      edges.push(...img.edges);
      imagesProcessed++;
      resolvedCheckpoints.push(`image_analysis:${img.filePath}`);
    } catch (err) {
      failures++;
      sdk.logger.error(
        `Failed to embed and ingest image at ${img.filePath}:`,
        err,
      );
    }
  }

  // 3. Commit Graph entities & edges
  const edgesCreated = commitVaultGraph(sdk, entities, edges);
  for (const id of resolvedCheckpoints) sdk.deleteCheckpoint(id);
  if (failures)
    throw new Error(
      `Vault finalization has ${failures} failure(s); watermark retained for retry`,
    );

  // 4. Advance Watermark
  if (prepared.maxMtime > 0) {
    const watermarkKey = `vault:${prepared.vault.path}:mtime`;
    sdk.state.setWatermark(String(prepared.maxMtime), watermarkKey);
  }
  if (prepared.checkpointId) sdk.deleteCheckpoint(prepared.checkpointId);

  sdk.logger.log(
    `Vault "${prepared.vault.name}" processed successfully (${notesProcessed} notes, ${imagesProcessed} images). Watermark advanced to ${prepared.maxMtime}.`,
  );

  return {
    vaultName: prepared.vault.name,
    notesProcessed,
    imagesProcessed,
    chunksCreated: totalChunksCreated,
    edgesCreated,
    watermarkAdvancedTo: prepared.maxMtime,
  };
}

/**
 * Processes an individual Obsidian vault using the two-phase pipeline:
 * Phase 1: All Chat model work (content expansion, image descriptions).
 * Phase 2: All Embedding model work (embeddings, DB chunk ingestion, graph edges).
 */
export async function processVault(
  vault: VaultInfo,
  sdkOverride?: ShaleSDK,
  forceAll: boolean = false,
): Promise<ProcessVaultResult> {
  const sdk = sdkOverride ?? getSDK();
  return sdk.models.batch(
    () => prepareVault(vault, sdk, forceAll),
    (prepared) => finalizeVault(prepared, sdk),
  );
}

export default processVault;
