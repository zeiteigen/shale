import { getSDK, type ShaleSDK } from "@shale/sdk";
import { parseFile, type ParsedFile, type ContextualChunk } from "./parse-file";

export interface NoteGraphElements {
  entities: Array<{ name: string; type: string }>;
  edges: Array<{ source: string; target: string; relation: string }>;
}

export interface IngestFileResult {
  filePath: string;
  noteTitle: string;
  chunksCreated: number;
  entities: Array<{ name: string; type: string }>;
  edges: Array<{ source: string; target: string; relation: string }>;
}

/**
 * Generates a normalized deterministic fallback embedding vector.
 */
export function generateFallbackEmbedding(dimensions: number = 4096): number[] {
  const v = new Float32Array(dimensions);
  let sumSq = 0;
  for (let i = 0; i < dimensions; i++) {
    v[i] = ((i % 19) - 9) / 100;
    sumSq += v[i] * v[i];
  }
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < dimensions; i++) v[i] /= norm;
  return Array.from(v);
}

/**
 * Generates an array of fallback embeddings for a given count of chunks.
 */
export function generateFallbackEmbeddings(
  count: number,
  dimensions: number = 4096,
): number[][] {
  return Array.from({ length: count }, () =>
    generateFallbackEmbedding(dimensions),
  );
}

/**
 * Generates embeddings via SDK with fallback vector generation on error.
 */
export async function embedContextualChunks(
  sdk: ShaleSDK,
  contextualChunks: ContextualChunk[],
  noteTitle: string,
): Promise<number[][]> {
  const textsToEmbed = contextualChunks.map((c) => c.text_content);
  if (textsToEmbed.length === 0) {
    return [];
  }

  try {
    return await sdk.embed(textsToEmbed);
  } catch (embedErr) {
    console.warn(
      `[Obsidian] Embedding failed for "${noteTitle}", using fallback vector:`,
      embedErr,
    );
    return generateFallbackEmbeddings(contextualChunks.length);
  }
}

/**
 * Builds entities and graph edges for a note and its wikilinks.
 */
export function buildNoteGraphElements(
  noteTitle: string,
  vaultEntityName: string,
  wikilinks: string[],
): NoteGraphElements {
  const entities: Array<{ name: string; type: string }> = [
    { name: noteTitle, type: "Note" },
  ];
  const edges: Array<{ source: string; target: string; relation: string }> = [
    {
      source: noteTitle,
      target: vaultEntityName,
      relation: "IN_SAME_VAULT",
    },
  ];

  for (const targetNote of wikilinks) {
    entities.push({ name: targetNote, type: "Note" });
    edges.push({
      source: noteTitle,
      target: targetNote,
      relation: "REFERENCES",
    });
  }

  return { entities, edges };
}

/**
 * Ingests an individual file using the Shale SDK:
 * 1. Calls parseFile to read and structure note content
 * 2. Checks context hydration
 * 3. Embeds contextual chunks
 * 4. Atomically ingests source and chunks
 * 5. Constructs note graph entities and edges
 */
export async function ingestFile(
  filePath: string,
  vaultEntityName: string = "Vault",
  sdkOverride?: ShaleSDK,
): Promise<IngestFileResult> {
  const sdk = sdkOverride ?? getSDK();

  // Parse markdown file and construct contextual chunks
  const parsedFile = await parseFile(filePath);

  // Check context hydration for historical continuity
  const existingContext = sdk.context.hydrate(parsedFile.noteUri, 3);
  if (existingContext.chunks.length > 0) {
    console.log(
      `[Obsidian] Hydrated ${existingContext.chunks.length} prior chunks for "${parsedFile.noteTitle}"`,
    );
  }

  // Generate embeddings (with fallback)
  const embeddings = await embedContextualChunks(
    sdk,
    parsedFile.contextualChunks,
    parsedFile.noteTitle,
  );

  // Ingest note source and chunks atomically
  const ingestResult = sdk.ingest.sourceAndChunks({
    source: {
      type: "markdown_note",
      uri: parsedFile.noteUri,
      origin: "obsidian",
      title: parsedFile.noteTitle,
      updated_at: parsedFile.updatedAt,
    },
    chunks: parsedFile.contextualChunks.map((chunk, idx) => ({
      chunk_index: chunk.chunk_index,
      text_content: chunk.text_content,
      embedding: embeddings[idx],
    })),
    namespace: "obsidian",
  });

  // Build Note entity, Vault membership edge, and wikilink reference edges
  const { entities, edges } = buildNoteGraphElements(
    parsedFile.noteTitle,
    vaultEntityName,
    parsedFile.parsed.wikilinks,
  );

  return {
    filePath,
    noteTitle: parsedFile.noteTitle,
    chunksCreated: ingestResult.chunksCount,
    entities,
    edges,
  };
}

export default ingestFile;
