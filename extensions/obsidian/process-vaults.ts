import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { getSDK, logger, type ShaleSDK } from "@shale/sdk";
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
  describeImageWithChatModel,
  type ParsedImage,
} from "./parse-image";
import {
  ingestFile,
  ingestImageFile,
  embedContextualChunks,
  generateFallbackEmbedding,
  generateFallbackEmbeddings,
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
  generateFallbackEmbedding,
  generateFallbackEmbeddings,
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
 * Recursively discovers all markdown files within a directory, ignoring hidden directories.
 */
export function findMarkdownFiles(
  dir: string,
  baseDir: string = dir,
): string[] {
  const files: string[] = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Ignore hidden directories like .obsidian, .git, .trash
      if (entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        files.push(...findMarkdownFiles(fullPath, baseDir));
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
 * Recursively discovers all image files within a directory, ignoring hidden directories.
 */
export function findImageFiles(dir: string, baseDir: string = dir): string[] {
  const files: string[] = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        files.push(...findImageFiles(fullPath, baseDir));
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
  vault: VaultInfo;
  maxMtime: number;
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

  const watermarkKey = `vault:${vault.path}:mtime`;
  const lastWatermark = forceAll
    ? 0
    : Number(sdk.state.getWatermark(watermarkKey) ?? "0");

  sdk.logger.log(
    `[Phase 1: Chat Model] Inspecting vault "${vault.name}" (last watermark: ${lastWatermark})`,
  );

  const allMdFiles = findMarkdownFiles(vault.path);
  const allImageFiles = findImageFiles(vault.path);

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

        // If the note has an AI summary / expanded chunk, save a checkpoint for crash recovery
        const hasExpandedSummary = fileResult.parsedFile.chunks.some((c) =>
          c.heading?.includes("(Expanded Context)"),
        );
        if (hasExpandedSummary && sdk?.saveCheckpoint) {
          try {
            sdk.saveCheckpoint(
              {
                type: "ai_summary",
                vault: { name: vault.name, path: vault.path },
                filePath,
                noteTitle: fileResult.parsedFile.noteTitle,
                noteUri: fileResult.parsedFile.noteUri,
                updatedAt: fileResult.parsedFile.updatedAt,
                parsedFile: fileResult.parsedFile,
                entities: [{ name: vaultEntityName, type: "Vault" }, ...fileResult.entities],
                edges: fileResult.edges,
                mtime: statSync(filePath).mtimeMs,
              },
              { id: `ai_summary:${filePath}`, key: `ai_summary:${filePath}` },
            );
          } catch (cpErr) {
            sdk.logger.warn(
              `Failed to save checkpoint for note "${fileResult.parsedFile.noteTitle}":`,
              cpErr,
            );
          }
        }
      }
    } catch (noteErr) {
      sdk.logger.error(`Failed to process note at ${filePath}:`, noteErr);
    }
  }

  // 2. Process modified images via ingestImageFile with deferEmbedding: true (calls parseImageFile & Chat model description)
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
      sdk.logger.error(`Failed to process image at ${imagePath}:`, imgErr);
    }
  }

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
          text_content: chunk.text_content,
          embedding: embeddings[idx],
        })),
        namespace: "obsidian",
      });

      totalChunksCreated += ingestResult.chunksCount;
      entities.push(...note.entities);
      edges.push(...note.edges);
      notesProcessed++;

      // Successfully ingested into database; resolve/delete checkpoint
      try {
        sdk.deleteCheckpoint?.(`ai_summary:${note.filePath}`);
      } catch {}
    } catch (err) {
      sdk.logger.error(
        `Failed to embed and ingest note at ${note.filePath}:`,
        err,
      );
    }
  }

  // 2. Embed and ingest all parsed images
  for (const img of prepared.parsedImages) {
    try {
      const embeddings = await embedContextualChunks(
        sdk,
        [img.parsedImage.contextualChunk],
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
        chunks: [
          {
            chunk_index: 0,
            text_content: img.parsedImage.contextualChunk.text_content,
            embedding: embeddings[0],
          },
        ],
        namespace: "obsidian",
      });

      totalChunksCreated += ingestResult.chunksCount;
      entities.push(...img.entities);
      edges.push(...img.edges);
      imagesProcessed++;
    } catch (err) {
      sdk.logger.error(
        `Failed to embed and ingest image at ${img.filePath}:`,
        err,
      );
    }
  }

  // 3. Commit Graph entities & edges
  const edgesCreated = commitVaultGraph(sdk, entities, edges);

  // 4. Advance Watermark
  if (prepared.maxMtime > 0) {
    const watermarkKey = `vault:${prepared.vault.path}:mtime`;
    sdk.state.setWatermark(String(prepared.maxMtime), watermarkKey);
  }

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
  const prepared = await prepareVault(vault, sdk, forceAll);
  return finalizeVault(prepared, sdk);
}

export default processVault;
