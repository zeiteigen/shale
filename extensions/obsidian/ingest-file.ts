import { getSDK, type ShaleSDK } from "@shale/sdk";
import { parseFile, type ParsedFile, type ContextualChunk } from "./parse-file";
import { parseImageFile, type ParsedImage } from "./parse-image";

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

export interface IngestImageResult {
  filePath: string;
  imageTitle: string;
  chunksCreated: number;
  entities: Array<{ name: string; type: string }>;
  edges: Array<{ source: string; target: string; relation: string }>;
}

export interface IngestFileOptions {
  embeddings?: number[][];
  expandAtomicNotes?: boolean;
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
 * Separated cleanly from note chunking/parsing.
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
 * Builds entities and graph edges for a note, its wikilinks, and embedded images.
 */
export function buildNoteGraphElements(
  noteTitle: string,
  vaultEntityName: string,
  wikilinks: string[],
  images: string[] = [],
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

  for (const imgName of images) {
    entities.push({ name: imgName, type: "Image" });
    edges.push({
      source: noteTitle,
      target: imgName,
      relation: "FEATURES_IMAGE",
    });
  }

  return { entities, edges };
}

/**
 * Ingests an individual markdown file using the Shale SDK:
 * 1. Calls parseFile to read and structure note content (and expands atomic notes if enabled)
 * 2. Checks context hydration
 * 3. Embeds contextual chunks outside note chunking/parsing (or uses precomputed embeddings)
 * 4. Atomically ingests source and chunks
 * 5. Constructs note graph entities and edges (including FEATURES_IMAGE)
 */
export async function ingestFile(
  filePath: string,
  vaultEntityName: string = "Vault",
  sdkOverride?: ShaleSDK,
  options?: IngestFileOptions,
): Promise<IngestFileResult> {
  const sdk = sdkOverride ?? getSDK();

  // 1. Note chunking and parsing (NO embedding inside parseFile!)
  const parsedFile = await parseFile(filePath, sdk, {
    expandAtomicNotes: options?.expandAtomicNotes,
  });

  // Check context hydration for historical continuity
  const existingContext = sdk.context.hydrate(parsedFile.noteUri, 3);
  if (existingContext.chunks.length > 0) {
    console.log(
      `[Obsidian] Hydrated ${existingContext.chunks.length} prior chunks for "${parsedFile.noteTitle}"`,
    );
  }

  // 2. Embedding happens OUTSIDE note chunking/parsing
  const embeddings =
    options?.embeddings ??
    (await embedContextualChunks(
      sdk,
      parsedFile.contextualChunks,
      parsedFile.noteTitle,
    ));

  // 3. Ingest note source and chunks atomically
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

  // 4. Build Note entity, Vault membership edge, wikilink reference edges, and image feature edges
  const { entities, edges } = buildNoteGraphElements(
    parsedFile.noteTitle,
    vaultEntityName,
    parsedFile.parsed.wikilinks,
    parsedFile.parsed.images,
  );

  return {
    filePath,
    noteTitle: parsedFile.noteTitle,
    chunksCreated: ingestResult.chunksCount,
    entities,
    edges,
  };
}

/**
 * Ingests an individual image file using the Shale SDK:
 * 1. Calls parseImageFile to generate multimodal description using Chat model
 * 2. Embeds the description chunk outside of parsing (or uses precomputed embedding)
 * 3. Atomically ingests source and chunk
 * 4. Constructs Image graph entity and IN_SAME_VAULT edge
 */
export async function ingestImageFile(
  filePath: string,
  vaultEntityName: string = "Vault",
  sdkOverride?: ShaleSDK,
  precomputedEmbedding?: number[],
): Promise<IngestImageResult> {
  const sdk = sdkOverride ?? getSDK();

  // 1. Image parsing and multimodal description via Chat model (no embedding inside parser)
  const parsedImage = await parseImageFile(filePath, sdk);

  // 2. Embedding generated OUTSIDE parsing
  const embedding =
    precomputedEmbedding ??
    (
      await embedContextualChunks(
        sdk,
        [parsedImage.contextualChunk],
        parsedImage.imageTitle,
      )
    )[0];

  // 3. Atomically ingest image source and chunk
  const ingestResult = sdk.ingest.sourceAndChunks({
    source: {
      type: "image",
      uri: parsedImage.imageUri,
      origin: "obsidian",
      title: parsedImage.imageTitle,
      updated_at: parsedImage.updatedAt,
    },
    chunks: [
      {
        chunk_index: 0,
        text_content: parsedImage.contextualChunk.text_content,
        embedding,
      },
    ],
    namespace: "obsidian",
  });

  // 4. Image entity and Vault membership edge
  const entities: Array<{ name: string; type: string }> = [
    { name: parsedImage.imageTitle, type: "Image" },
  ];
  const edges: Array<{ source: string; target: string; relation: string }> = [
    {
      source: parsedImage.imageTitle,
      target: vaultEntityName,
      relation: "IN_SAME_VAULT",
    },
  ];

  return {
    filePath,
    imageTitle: parsedImage.imageTitle,
    chunksCreated: ingestResult.chunksCount,
    entities,
    edges,
  };
}

export default ingestFile;
