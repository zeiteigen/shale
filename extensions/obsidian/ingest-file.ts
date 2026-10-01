import { getSDK, logger, getSetting, type ShaleSDK } from "@shale/sdk";
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
  contextHydrationLimit?: number;
  namespace?: string;
}

export interface IngestImageOptions {
  precomputedEmbedding?: number[];
  precomputedEmbeddings?: number[][];
  deferEmbedding?: boolean;
  parsedImage?: ParsedImage;
  namespace?: string;
}

/** Failed embeddings stay pending; fabricated vectors never enter the index. */
export async function embedContextualChunks(
  sdk: ShaleSDK,
  contextualChunks: ContextualChunk[],
  _noteTitle: string,
): Promise<number[][]> {
  const texts = contextualChunks.map((chunk) => chunk.text_content);
  return texts.length ? sdk.embed(texts) : [];
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

  const prepare = async () =>
    options?.parsedFile ??
    parseFile(filePath, sdk, {
      expandAtomicNotes: options?.expandAtomicNotes,
    });
  const finalize = async (
    parsedFile: ParsedFile,
  ): Promise<IngestFileResult> => {
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
    const hydrationLimit =
      options?.contextHydrationLimit ??
      sdk?.settings.get<number>("contextHydrationLimit") ??
      getSetting<number>("contextHydrationLimit", 3);

    const existingContext = sdk.context.hydrate(
      parsedFile.noteUri,
      hydrationLimit,
    );
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

    const ns =
      options?.namespace ??
      sdk?.settings.get<string>("namespace") ??
      getSetting<string>("namespace", "obsidian");

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
        chunk_type: chunk.chunk_type ?? "verbatim",
        text_content: chunk.text_content,
        embedding: embeddings[idx],
      })),
      namespace: ns,
    });

    return {
      filePath,
      noteTitle: parsedFile.noteTitle,
      chunksCreated: ingestResult.chunksCount,
      entities,
      edges,
      parsedFile,
    };
  };
  return options?.deferEmbedding
    ? sdk.models.phase("chat", async () => finalize(await prepare()))
    : sdk.models.batch(prepare, finalize);
}

/**
 * Ingests an individual image file using the Shale SDK:
 * 1. Calls parseImageFile to generate multimodal description using Chat model
 * 2. Embeds the description chunks outside of parsing (or uses precomputed embeddings)
 * 3. Atomically ingests source and chunks with chunk_type (verbatim for layout, synthetic for meaning)
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

  const prepare = async () =>
    options.parsedImage ?? parseImageFile(filePath, sdk);
  const finalize = async (
    parsedImage: ParsedImage,
  ): Promise<IngestImageResult> => {
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
    const targetChunks =
      parsedImage.contextualChunks && parsedImage.contextualChunks.length > 0
        ? parsedImage.contextualChunks
        : [parsedImage.contextualChunk];

    let embeddings: number[][];
    if (
      options.precomputedEmbeddings &&
      options.precomputedEmbeddings.length >= targetChunks.length
    ) {
      embeddings = options.precomputedEmbeddings;
    } else if (options.precomputedEmbedding) {
      if (targetChunks.length === 1) {
        embeddings = [options.precomputedEmbedding];
      } else {
        const restEmbeddings = await embedContextualChunks(
          sdk,
          targetChunks.slice(1),
          parsedImage.imageTitle,
        );
        embeddings = [options.precomputedEmbedding, ...restEmbeddings];
      }
    } else {
      embeddings = await embedContextualChunks(
        sdk,
        targetChunks,
        parsedImage.imageTitle,
      );
    }

    const imageNs =
      options.namespace ??
      sdk?.settings.get<string>("namespace") ??
      getSetting<string>("namespace", "obsidian");

    // 3. Atomically ingest image source and chunks
    const ingestResult = sdk.ingest.sourceAndChunks({
      source: {
        type: "image",
        uri: parsedImage.imageUri,
        origin: "obsidian",
        title: parsedImage.imageTitle,
        updated_at: parsedImage.updatedAt,
      },
      chunks: targetChunks.map((chunk, idx) => ({
        chunk_index: chunk.chunk_index,
        chunk_type:
          chunk.chunk_type ??
          (chunk.chunk_index === 0 ? "verbatim" : "synthetic"),
        text_content: chunk.text_content,
        embedding: embeddings[idx],
      })),
      namespace: imageNs,
    });

    return {
      filePath,
      imageTitle: parsedImage.imageTitle,
      chunksCreated: ingestResult.chunksCount,
      entities,
      edges,
      parsedImage,
    };
  };
  return options.deferEmbedding
    ? sdk.models.phase("chat", async () => finalize(await prepare()))
    : sdk.models.batch(prepare, finalize);
}

export default ingestFile;
