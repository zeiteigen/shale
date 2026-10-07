import { commitNote, commitImage } from "./commit";
import { createNoteIndex } from "./link-targets";
import { findDocumentFiles } from "./document-files";
import { documentWatermarkKey, finalizeDocument, prepareVaultDocuments } from "./document-vault";
import { unfinishedFiles } from "./file-progress";
import type { ParsedDocument } from "./parse-document";
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
  documentsProcessed: number;
  chunksCreated: number;
  edgesCreated: number;
  watermarkAdvancedTo: number;
  documentWatermarkAdvancedTo?: number;
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
export { findDocumentFiles } from "./document-files";
export { parseDocumentFile, type ParsedDocument } from "./parse-document";
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
 * 1. Discovers and filters modified notes, images, and documents.
 */
export interface PreparedVault {
  namespace?: string;
  checkpointId?: string;
  vault: VaultInfo;
  maxMtime: number;
  maxDocumentMtime?: number;
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
  parsedDocuments: ParsedDocument[];
  parsedImages: Array<{
    filePath: string;
    parsedImage: ParsedImage;
    entities: Array<{ name: string; type: string }>;
    edges: Array<{ source: string; target: string; relation: string }>;
  }>;
}

/**
 * Phase 1: Discovers modified notes, images, and documents and executes all Chat work
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
  const includeDocuments = sdk.settings.get<boolean>("includeDocuments") ?? true;
  const ignoredDirectories =
    sdk.settings.get<string[]>("ignoredDirectories") ??
    getSetting<string[]>("ignoredDirectories");

  const allMdFiles = includeMarkdown
    ? findMarkdownFiles(vault.path, vault.path, ignoredDirectories)
    : [];
  const allImageFiles = includeImages
    ? findImageFiles(vault.path, vault.path, ignoredDirectories)
    : [];
  const allDocumentFiles = includeDocuments
    ? findDocumentFiles(vault.path, ignoredDirectories, sdk.settings.get<string[]>("documentExtensions"))
    : [];

  const namespace = sdk.settings.get<string>("namespace") ?? sdk.namespace ?? "obsidian";
  const { modifiedFiles: discoveredNotes, maxMtime: maxNoteMtime } =
    filterModifiedFiles(allMdFiles, lastWatermark);
  const { modifiedFiles: discoveredImages, maxMtime: maxImageMtime } =
    filterModifiedFiles(allImageFiles, lastWatermark);
  // Documents have their own cursor so existing note/image cursors cannot skip
  // older attachments when this connector gains document support.
  const lastDocumentWatermark = force ? 0 : Number(sdk.state.getWatermark(documentWatermarkKey(vault.path)) ?? "0");
  const { modifiedFiles: discoveredDocuments, maxMtime: maxDocumentMtime } =
    filterModifiedFiles(allDocumentFiles, lastDocumentWatermark);
  const modifiedNotes = unfinishedFiles(discoveredNotes, sdk, namespace, !!force);
  const modifiedImages = unfinishedFiles(discoveredImages, sdk, namespace, !!force);
  const modifiedDocuments = unfinishedFiles(discoveredDocuments, sdk, namespace, !!force);

  const maxMtime = Math.max(maxNoteMtime, maxImageMtime);
  const vaultEntityName = `Vault: ${vault.name}`;

  const prepared: PreparedVault = {
    vault,
    namespace,
    maxMtime,
    maxDocumentMtime: includeDocuments ? maxDocumentMtime : undefined,
    vaultEntityName,
    entities: [{ name: vaultEntityName, type: "Vault" }],
    edges: [],
    parsedNotes: [],
    parsedImages: [],
    parsedDocuments: [],
  };

  if (modifiedNotes.length === 0 && modifiedImages.length === 0 && modifiedDocuments.length === 0) {
    sdk.logger.log(`Vault "${vault.name}" has no updates since last run.`);
    return prepared;
  }

  sdk.logger.log(
    `[Phase 1: Chat Model] Processing ${modifiedNotes.length} note(s), ${modifiedImages.length} image(s), and ${modifiedDocuments.length} document(s) in "${vault.name}"...`,
  );

  const noteIndex = createNoteIndex([...allMdFiles,...allImageFiles,...allDocumentFiles]);

  // 1. Process modified notes via ingestFile with deferEmbedding: true (calls parseFile & Chat model expansion)
  await sdk.models.mapChat(modifiedNotes, async (filePath) => {
    try {
      const fileResult = await ingestFile(filePath, vaultEntityName, sdk, {
        deferEmbedding: true,
        vaultPath: vault.path,
        noteIndex,
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
            namespace:prepared.namespace,
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
  });

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
      prepared.preparationFailed = true;
    }
  }

  if (prepared.parsedImages.length !== modifiedImages.length)
    prepared.preparationFailed = true;
  for (const image of prepared.parsedImages) {
    sdk.saveCheckpoint(
      {
        type: "image_analysis",
        namespace:prepared.namespace,
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

  const documentBatch = await prepareVaultDocuments(modifiedDocuments, vault, sdk, prepared.namespace!);
  prepared.parsedDocuments = documentBatch.documents;
  if (documentBatch.failed) prepared.preparationFailed = true;

  prepared.checkpointId = `vault_batch:${vault.path}`;
  sdk.saveCheckpoint(
    {
      type: "vault_batch",
      vault: { name: vault.name, path: vault.path },
      maxMtime,
      maxDocumentMtime: prepared.maxDocumentMtime,
      preparationFailed: prepared.preparationFailed ?? false,
    },
    { id: prepared.checkpointId, key: prepared.checkpointId },
  );

  sdk.logger.log(
    `[Phase 1: Chat Model] Finished preparation for "${vault.name}" (${prepared.parsedNotes.length} note(s), ${prepared.parsedImages.length} image(s), ${prepared.parsedDocuments.length} document(s)).`,
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

  const documents = prepared.parsedDocuments ?? [];
  if (prepared.parsedNotes.length === 0 && prepared.parsedImages.length === 0 && documents.length === 0) {
    if (prepared.preparationFailed)
      throw new Error("Vault preparation failed; watermark retained for retry");
    return {
      vaultName: prepared.vault.name,
      notesProcessed: 0,
      imagesProcessed: 0,
      documentsProcessed: 0,
      chunksCreated: 0,
      edgesCreated: 0,
      watermarkAdvancedTo: prepared.maxMtime,
      documentWatermarkAdvancedTo: prepared.maxDocumentMtime,
    };
  }

  sdk.logger.log(
    `[Phase 2: Embedding Model] Embedding and ingesting ${prepared.parsedNotes.length} note(s), ${prepared.parsedImages.length} image(s), and ${documents.length} document(s) for "${prepared.vault.name}"...`,
  );

  let totalChunksCreated = 0;
  let notesProcessed = 0;
  let imagesProcessed = 0;
  let documentsProcessed = 0;
  let failures = prepared.preparationFailed ? 1 : 0;
  let edgesCreated = 0;
  const namespace = prepared.namespace ?? sdk.settings.get<string>("namespace") ?? sdk.namespace ?? "obsidian";

  // 1. Embed and ingest all parsed notes
  for (const note of prepared.parsedNotes) {
    try {
      const embeddings = await embedContextualChunks(
        sdk,
        note.parsedFile.contextualChunks,
        note.parsedFile.noteTitle,
      );

      const ingestResult = commitNote(sdk,note.parsedFile,embeddings,prepared.vault,namespace,`ai_summary:${note.filePath}`);
      totalChunksCreated += ingestResult.chunksCount;
      edgesCreated += ingestResult.edgesCreated;
      notesProcessed++;
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

      const ingestResult = commitImage(sdk,img.parsedImage,embeddings,prepared.vault,namespace,`image_analysis:${img.filePath}`);
      totalChunksCreated += ingestResult.chunksCount;
      edgesCreated += ingestResult.edgesCreated;
      imagesProcessed++;
    } catch (err) {
      failures++;
      sdk.logger.error(
        `Failed to embed and ingest image at ${img.filePath}:`,
        err,
      );
    }
  }

  for (const document of documents) {
    try {
      const result = await finalizeDocument(document, prepared.vault, sdk, namespace);
      totalChunksCreated += result.chunksCount;
      edgesCreated += result.edgesCreated;
      documentsProcessed++;
    } catch (error) {
      failures++;
      sdk.logger.error(`Failed to embed and ingest document at ${document.filePath}:`, error);
    }
  }

  // 3. Commit Graph entities & edges
  if (failures)
    throw new Error(
      `Vault finalization has ${failures} failure(s); watermark retained for retry`,
    );

  // 4. Advance Watermark
  if (prepared.maxMtime > 0) {
    const watermarkKey = `vault:${prepared.vault.path}:mtime`;
    sdk.state.setWatermark(String(prepared.maxMtime), watermarkKey);
  }
  if (prepared.maxDocumentMtime !== undefined && prepared.maxDocumentMtime > 0) {
    sdk.state.setWatermark(String(prepared.maxDocumentMtime), documentWatermarkKey(prepared.vault.path));
  }
  if (prepared.checkpointId) sdk.deleteCheckpoint(prepared.checkpointId);

  sdk.logger.log(
    `Vault "${prepared.vault.name}" processed successfully (${notesProcessed} notes, ${imagesProcessed} images, ${documentsProcessed} documents).`,
  );

  return {
    vaultName: prepared.vault.name,
    notesProcessed,
    imagesProcessed,
    documentsProcessed,
    chunksCreated: totalChunksCreated,
    edgesCreated,
    watermarkAdvancedTo: prepared.maxMtime,
    documentWatermarkAdvancedTo: prepared.maxDocumentMtime,
  };
}

/**
 * Processes an individual Obsidian vault using the two-phase pipeline:
 * Phase 1: All parsing and Chat model work (content expansion, image/document descriptions).
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
