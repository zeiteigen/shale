import { getSDK, logger, type ShaleSDK } from "@shale/sdk";
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
  parsedFile?: ParsedFile;
}

export interface IngestImageResult {
  filePath: string;
  imageTitle: string;
  chunksCreated: number;
  entities: Array<{ name: string; type: string }>;
  edges: Array<{ source: string; target: string; relation: string }>;
  parsedImage?: ParsedImage;
}

export interface IngestFileOptions {
  embeddings?: number[][];
  expandAtomicNotes?: boolean;
  deferEmbedding?: boolean;
  parsedFile?: ParsedFile;
}

export interface IngestImageOptions {
  precomputedEmbedding?: number[];
  deferEmbedding?: boolean;
  parsedImage?: ParsedImage;
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
    (sdk?.logger ?? logger).warn(
      `Embedding failed for "${noteTitle}", using fallback vector:`,
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
  const parsedFile =
    options?.parsedFile ??
    (await parseFile(filePath, sdk, {
      expandAtomicNotes: options?.expandAtomicNotes,
    }));

  // Build Note entity, Vault membership edge, wikilink reference edges, and image feature edges
  const { entities, edges } = buildNoteGraphElements(
    parsedFile.noteTitle,
    vaultEntityName,
    parsedFile.parsed.wikilinks,
    parsedFile.parsed.images,
  );

  // If embedding is deferred (Phase 1 Chat-only phase), return early without calling embedder
  if (options?.deferEmbedding) {
    return {
      filePath,
      noteTitle: parsedFile.noteTitle,
      chunksCreated: 0,
      entities,
      edges,
      parsedFile,
    };
  }

  // Check context hydration for historical continuity
  const existingContext = sdk.context.hydrate(parsedFile.noteUri, 3);
  if (existingContext.chunks.length > 0) {
    (sdk?.logger ?? logger).log(
      `Hydrated ${existingContext.chunks.length} prior chunks for "${parsedFile.noteTitle}"`,
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

  return {
    filePath,
    noteTitle: parsedFile.noteTitle,
    chunksCreated: ingestResult.chunksCount,
    entities,
    edges,
    parsedFile,
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
  embeddingOrOptions?: number[] | IngestImageOptions,
): Promise<IngestImageResult> {
  const sdk = sdkOverride ?? getSDK();

  const options: IngestImageOptions = Array.isArray(embeddingOrOptions)
    ? { precomputedEmbedding: embeddingOrOptions }
    : (embeddingOrOptions ?? {});

  // 1. Image parsing and multimodal description via Chat model (no embedding inside parser)
  const parsedImage =
    options.parsedImage ?? (await parseImageFile(filePath, sdk));

  // Image entity and Vault membership edge
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

  // If embedding is deferred (Phase 1 Chat-only phase), return early without calling embedder
  if (options.deferEmbedding) {
    return {
      filePath,
      imageTitle: parsedImage.imageTitle,
      chunksCreated: 0,
      entities,
      edges,
      parsedImage,
    };
  }

  // 2. Embedding generated OUTSIDE parsing
  const embedding =
    options.precomputedEmbedding ??
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

  return {
    filePath,
    imageTitle: parsedImage.imageTitle,
    chunksCreated: ingestResult.chunksCount,
    entities,
    edges,
    parsedImage,
  };
}

export default ingestFile;
