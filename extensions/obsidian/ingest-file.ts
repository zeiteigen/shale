import { dirname } from "node:path";
import { commitNote, commitImage } from "./commit";
import { createNoteIndex, indexVault, resolveNoteLinks } from './link-targets';
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
  expandAtomicNotes?: boolean;
  prepareOnly?: boolean;
  parsedFile?: ParsedFile;
  contextHydrationLimit?: number;
  namespace?: string;
  vaultPath?: string;
  noteIndex?: ReturnType<typeof createNoteIndex>;
}

export interface IngestImageOptions {
  prepareOnly?: boolean;
  parsedImage?: ParsedImage;
  namespace?: string;
  vaultPath?: string;
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
 * 3. Atomically ingests source and chunks
 * 4. Constructs note graph entities and edges (including FEATURES_IMAGE)
 */
export async function ingestFile(
  filePath: string,
  vaultEntityName: string = "Vault",
  sdkOverride?: ShaleSDK,
  options?: IngestFileOptions,
): Promise<IngestFileResult> {
  const sdk = sdkOverride ?? getSDK();

  const prepare = async () => {
    const file = options?.parsedFile ?? await parseFile(filePath, sdk, {
      expandAtomicNotes: options?.expandAtomicNotes,
    });
    if (!file.linkTargets) {
      const vaultPath = options?.vaultPath ?? dirname(filePath);
      const index = options?.noteIndex ?? indexVault(vaultPath,sdk.settings.get<string[]>('ignoredDirectories'));
      resolveNoteLinks(file,vaultPath,index);
    }
    return file;
  };
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

    if (options?.prepareOnly) {
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

    const ns =
      options?.namespace ??
      sdk?.settings.get<string>("namespace") ??
      getSetting<string>("namespace", "obsidian");

    // 3. Ingest note source and chunks atomically
    const ingestResult = commitNote(sdk,parsedFile,
      {name:vaultEntityName.replace(/^Vault: /,""),path:options?.vaultPath ?? dirname(filePath)},ns);

    return {
      filePath,
      noteTitle: parsedFile.noteTitle,
      chunksCreated: ingestResult.chunksCount,
      entities,
      edges,
      parsedFile,
    };
  };
  return sdk.models.batch(prepare, finalize);
}

/**
 * Ingests an individual image file using the Shale SDK:
 * 1. Calls parseImageFile to generate multimodal description using Chat model
 * 2. Atomically ingests source, synthetic vision chunks, and evidence-backed graph claims
 * 3. Commits the Image identity and directed vault membership
 */
export async function ingestImageFile(
  filePath: string,
  vaultEntityName: string = "Vault",
  sdkOverride?: ShaleSDK,
  imageOptions?: IngestImageOptions,
): Promise<IngestImageResult> {
  const sdk = sdkOverride ?? getSDK();

  const options = imageOptions ?? {};

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

    if (options.prepareOnly) {
      return {
        filePath,
        imageTitle: parsedImage.imageTitle,
        chunksCreated: 0,
        entities,
        edges,
        parsedImage,
      };
    }

    const imageNs =
      options.namespace ??
      sdk?.settings.get<string>("namespace") ??
      getSetting<string>("namespace", "obsidian");

    // 3. Atomically ingest image source and chunks
    const ingestResult = commitImage(sdk,parsedImage,
      {name:vaultEntityName.replace(/^Vault: /,""),path:options.vaultPath ?? dirname(filePath)},imageNs);

    return {
      filePath,
      imageTitle: parsedImage.imageTitle,
      chunksCreated: ingestResult.chunksCount,
      entities,
      edges,
      parsedImage,
    };
  };
  return sdk.models.batch(prepare, finalize);
}

export default ingestFile;
