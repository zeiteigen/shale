import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { getSDK, type ShaleSDK } from "@shale/sdk";
import { type VaultInfo } from "./vault-finder";
import {
  parseFile,
  buildContextualChunks,
  type ParsedFile,
  type ContextualChunk,
} from "./parse-file";
import {
  ingestFile,
  embedContextualChunks,
  generateFallbackEmbedding,
  generateFallbackEmbeddings,
  buildNoteGraphElements,
  type IngestFileResult,
  type NoteGraphElements,
} from "./ingest-file";

export interface ProcessVaultResult {
  vaultName: string;
  notesProcessed: number;
  chunksCreated: number;
  edgesCreated: number;
  watermarkAdvancedTo: number;
}

// Re-export file parsing and ingestion primitives for convenient access
export {
  parseFile,
  buildContextualChunks,
  type ParsedFile,
  type ContextualChunk,
};
export {
  ingestFile,
  embedContextualChunks,
  generateFallbackEmbedding,
  generateFallbackEmbeddings,
  buildNoteGraphElements,
  type IngestFileResult,
  type NoteGraphElements,
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
 * Processes an individual Obsidian vault using the Shale SDK.
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
  const { modifiedFiles, maxMtime } = filterModifiedFiles(
    allMdFiles,
    lastWatermark,
  );

  if (modifiedFiles.length === 0) {
    console.log(
      `[Obsidian] Vault "${vault.name}" has no updates since last run.`,
    );
    return {
      vaultName: vault.name,
      notesProcessed: 0,
      chunksCreated: 0,
      edgesCreated: 0,
      watermarkAdvancedTo: lastWatermark,
    };
  }

  console.log(
    `[Obsidian] Found ${modifiedFiles.length} updated notes to process in "${vault.name}"`,
  );

  const vaultEntityName = `Vault: ${vault.name}`;
  const entities: Array<{ name: string; type: string }> = [
    { name: vaultEntityName, type: "Vault" },
  ];
  const edges: Array<{ source: string; target: string; relation: string }> = [];

  let totalChunksCreated = 0;

  // 1. Process modified notes via ingestFile (which calls parseFile)
  for (const filePath of modifiedFiles) {
    try {
      const fileResult = await ingestFile(filePath, vaultEntityName, sdk);
      totalChunksCreated += fileResult.chunksCreated;
      entities.push(...fileResult.entities);
      edges.push(...fileResult.edges);
    } catch (noteErr) {
      console.error(
        `[Obsidian] Failed to process note at ${filePath}:`,
        noteErr,
      );
    }
  }

  // 2. Commit Graph entities & edges
  const edgesCreated = commitVaultGraph(sdk, entities, edges);

  // 3. Advance Watermark
  sdk.state.setWatermark(String(maxMtime), watermarkKey);
  console.log(
    `[Obsidian] Vault "${vault.name}" processed successfully. Watermark advanced to ${maxMtime}.`,
  );

  return {
    vaultName: vault.name,
    notesProcessed: modifiedFiles.length,
    chunksCreated: totalChunksCreated,
    edgesCreated,
    watermarkAdvancedTo: maxMtime,
  };
}

export default processVault;
