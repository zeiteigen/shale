import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { getSDK, type ShaleSDK } from "@shale/sdk";
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
    console.warn(`[Obsidian] Error scanning directory ${dir}:`, err);
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
    console.warn(`[Obsidian] Error scanning directory ${dir} for images:`, err);
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
 * 2. Parses and chunks notes (including whole note + Chat model expansion for atomic notes).
 * 3. Parses images using Chat model for layout and meaning descriptions.
 * 4. Embeds chunks outside of note chunking/parsing (supporting local embedding models).
 * 5. Ingests sources, chunks, and commits graph entities/edges.
 */
export async function processVault(
  vault: VaultInfo,
  sdkOverride?: ShaleSDK,
  forceAll: boolean = false,
): Promise<ProcessVaultResult> {
  const sdk = sdkOverride ?? getSDK();

  const watermarkKey = `vault:${vault.path}:mtime`;
  const lastWatermark = forceAll
    ? 0
    : Number(sdk.state.getWatermark(watermarkKey) ?? "0");

  console.log(
    `[Obsidian] Processing vault "${vault.name}" (last watermark: ${lastWatermark})`,
  );

  const allMdFiles = findMarkdownFiles(vault.path);
  const allImageFiles = findImageFiles(vault.path);

  const { modifiedFiles: modifiedNotes, maxMtime: maxNoteMtime } =
    filterModifiedFiles(allMdFiles, lastWatermark);
  const { modifiedFiles: modifiedImages, maxMtime: maxImageMtime } =
    filterModifiedFiles(allImageFiles, lastWatermark);

  const maxMtime = Math.max(maxNoteMtime, maxImageMtime);

  if (modifiedNotes.length === 0 && modifiedImages.length === 0) {
    console.log(
      `[Obsidian] Vault "${vault.name}" has no updates since last run.`,
    );
    return {
      vaultName: vault.name,
      notesProcessed: 0,
      imagesProcessed: 0,
      chunksCreated: 0,
      edgesCreated: 0,
      watermarkAdvancedTo: lastWatermark,
    };
  }

  console.log(
    `[Obsidian] Found ${modifiedNotes.length} updated note(s) and ${modifiedImages.length} updated image(s) to process in "${vault.name}"`,
  );

  const vaultEntityName = `Vault: ${vault.name}`;
  const entities: Array<{ name: string; type: string }> = [
    { name: vaultEntityName, type: "Vault" },
  ];
  const edges: Array<{ source: string; target: string; relation: string }> = [];

  let totalChunksCreated = 0;
  let notesProcessed = 0;
  let imagesProcessed = 0;

  // 1. Process modified notes via ingestFile (which calls parseFile)
  for (const filePath of modifiedNotes) {
    try {
      const fileResult = await ingestFile(filePath, vaultEntityName, sdk);
      totalChunksCreated += fileResult.chunksCreated;
      entities.push(...fileResult.entities);
      edges.push(...fileResult.edges);
      notesProcessed++;
    } catch (noteErr) {
      console.error(
        `[Obsidian] Failed to process note at ${filePath}:`,
        noteErr,
      );
    }
  }

  // 2. Process modified images via ingestImageFile (which uses Chat model for layout and meaning)
  for (const imagePath of modifiedImages) {
    try {
      const imageResult = await ingestImageFile(
        imagePath,
        vaultEntityName,
        sdk,
      );
      totalChunksCreated += imageResult.chunksCreated;
      entities.push(...imageResult.entities);
      edges.push(...imageResult.edges);
      imagesProcessed++;
    } catch (imgErr) {
      console.error(
        `[Obsidian] Failed to process image at ${imagePath}:`,
        imgErr,
      );
    }
  }

  // 3. Commit Graph entities & edges
  const edgesCreated = commitVaultGraph(sdk, entities, edges);

  // 4. Advance Watermark
  sdk.state.setWatermark(String(maxMtime), watermarkKey);
  console.log(
    `[Obsidian] Vault "${vault.name}" processed successfully (${notesProcessed} notes, ${imagesProcessed} images). Watermark advanced to ${maxMtime}.`,
  );

  return {
    vaultName: vault.name,
    notesProcessed,
    imagesProcessed,
    chunksCreated: totalChunksCreated,
    edgesCreated,
    watermarkAdvancedTo: maxMtime,
  };
}

export default processVault;
