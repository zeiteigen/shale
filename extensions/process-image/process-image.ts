import { basename } from "node:path";
import { statSync, existsSync } from "node:fs";
import { getSDK, logger, getSetting, type ShaleSDK } from "@shale/sdk";
import type {
  ProcessFileRequest,
  ProcessFileResponse,
  ProcessFilesBatchItem,
  ProcessFilesBatchRequest,
  ProcessFilesBatchResponse,
  ProcessedChunk,
  ProcessedEntity,
  ProcessedEdge,
} from "../../lib/messages.types";
import type { ProcessImageSettings } from "./settings.types";

export const DEFAULT_IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "svg",
  "bmp",
  "tiff",
]);

/**
 * Checks whether a given file path corresponds to a supported image format.
 */
export function canProcessImage(
  filePath: string,
  customExtensions?: string[] | Set<string>,
): boolean {
  const cleanPath = filePath.split("?")[0].split("#")[0];
  const ext = cleanPath.split(".").pop()?.toLowerCase();
  if (!ext) return false;

  if (customExtensions) {
    const active =
      customExtensions instanceof Set
        ? customExtensions
        : new Set(customExtensions.map((e) => e.toLowerCase().replace(/^\./, "")));
    return active.has(ext);
  }

  const configured = getSetting<string[]>("supportedExtensions");
  if (Array.isArray(configured) && configured.length > 0) {
    const active = new Set(
      configured.map((e) => e.toLowerCase().replace(/^\./, "")),
    );
    return active.has(ext);
  }

  return DEFAULT_IMAGE_EXTENSIONS.has(ext);
}

function isRemoteImageUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function imageDisplayName(value: string): string {
  if (isRemoteImageUrl(value)) {
    try { return basename(new URL(value).pathname) || new URL(value).hostname; } catch {}
  }
  return basename(value);
}

/**
 * Prompts the SDK Chat model to generate a comprehensive multimodal description
 * covering both physical layout/visual elements and the underlying conceptual explanation/meaning.
 */
export async function describeImageWithChatModel(
  sdk: ShaleSDK,
  imagePath: string,
  imageName: string,
  timeoutMs?: number,
  promptOverride?: string,
): Promise<string> {
  const describeEnabled =
    sdk?.settings.get<boolean>("describeImages") ??
    getSetting<boolean>("describeImages", true);

  const fallbackTemplate =
    sdk?.settings.get<string>("fallbackDescriptionTemplate") ??
    getSetting<string>("fallbackDescriptionTemplate");

  const defaultFallback = fallbackTemplate
    ? fallbackTemplate.replace(/\{\{imageName\}\}/g, imageName)
    : `Detailed visual diagram and conceptual representation for ${imageName}. Covers physical layout, components, and underlying subject explanation.`;

  if (!describeEnabled) {
    return defaultFallback;
  }

  const prompt =
    promptOverride ??
    sdk?.settings.get<string>("imagePrompt") ??
    getSetting<string>("imagePrompt") ??
    `Please provide a detailed, comprehensive text description of this image.
Your description must thoroughly cover two essential aspects:
1. Physical layout and visual elements: Describe the layout, composition, visual components, diagram structure, charts, drawings, colors, labels, symbols, visible text, and spatial relationships.
2. Underlying explanation and meaning: Explain what concept, process, system, or idea the image conveys, its significance, scientific or contextual explanation, and how the visual elements represent the subject matter.`;

  const system =
    sdk?.settings.get<string>("imageSystemPrompt") ??
    getSetting<string>("imageSystemPrompt") ??
    "You are an expert multimodal analysis assistant. You analyze images to produce detailed, semantically rich descriptions capturing both visible layout elements and underlying conceptual meaning for semantic search and knowledge retrieval.";

  const effectiveTimeout =
    timeoutMs !== undefined
      ? timeoutMs
      : sdk?.settings.get<number>("imageTimeoutMs") ??
        getSetting<number>("imageTimeoutMs");

  try {
    const res = await sdk.queryLLM(
      {
        prompt,
        images: [imagePath],
        system,
      },
      effectiveTimeout !== undefined ? { timeoutMs: effectiveTimeout } : undefined,
    );

    return res.trim();
  } catch (err) {
    (sdk?.logger ?? logger).warn(
      `Chat model description failed for image "${imageName}":`,
      err,
    );
  }

  // Graceful fallback for offline testing or API failures
  return defaultFallback;
}

import type { ChunkType } from "../../lib/db";

export interface SplitImageDescription {
  layoutDescription: string;
  meaningDescription: string;
}

/**
 * Splits a multimodal vision description into:
 * 1. Geometric layout and visual elements (verbatim representation)
 * 2. Underlying conceptual explanation and meaning (synthetic reasoning)
 */
export function splitImageDescription(
  description: string,
  imageTitle: string = "image",
): SplitImageDescription {
  const trimmed = description.trim();

  // Look for section 2 delimiter anywhere after start
  const meaningRegex =
    /(?:^|\n+|(?:(?<=\.)\s+)|(?<=\b)\s{2,})(?:#+\s*)?(?:(?:2\.|Part\s*2:?|Section\s*2:?)\s*)?(?:Underlying\s*(?:explanation\s*(?:and|&)\s*meaning|explanation|meaning|significance|concepts?)|Meaning\s*(?:and|&)\s*explanation|Conceptual\s*meaning)[:\s]*/i;

  const match = meaningRegex.exec(trimmed);
  if (match && match.index > 0) {
    let layoutPart = trimmed.slice(0, match.index).trim();
    let meaningPart = trimmed.slice(match.index + match[0].length).trim();

    layoutPart = layoutPart
      .replace(
        /^(?:#+\s*)?(?:(?:1\.|Part\s*1:?|Section\s*1:?)\s*)?(?:Physical\s*(?:layout|appearance)\s*(?:and|&)\s*visual\s*elements|Visual\s*elements\s*(?:and|&)\s*(?:physical\s*)?layout|Visual\s*elements|Physical\s*layout|Layout)[:\s]*/i,
        "",
      )
      .trim();

    if (layoutPart.length > 0 && meaningPart.length > 0) {
      return {
        layoutDescription: layoutPart,
        meaningDescription: meaningPart,
      };
    }
  }

  return {
    layoutDescription: trimmed,
    meaningDescription: trimmed,
  };
}

export interface ContextualChunk {
  chunk_index: number;
  chunk_type: ChunkType;
  text_content: string;
  embedding?: number[];
}

export interface ParsedImageInfo {
  filePath: string;
  imageTitle: string;
  imageUri: string;
  updatedAt: number;
  description: string;
  layoutDescription: string;
  meaningDescription: string;
  contextualChunk: ContextualChunk;
  contextualChunks: ContextualChunk[];
}

/**
 * Parses an image file, extracting metadata and generating a detailed text description via LLM.
 */
export async function parseImageFile(
  filePath: string,
  sdkOverride?: ShaleSDK,
  options?: { timeoutMs?: number; prompt?: string },
): Promise<ParsedImageInfo> {
  const sdk = sdkOverride ?? getSDK();
  const imageTitle = imageDisplayName(filePath);
  const imageUri = isRemoteImageUrl(filePath)
    ? filePath
    : filePath.startsWith("file://") ? filePath : `file://${filePath}`;
  let updatedAt = Date.now();

  try {
    const rawPath = filePath.startsWith("file://") ? filePath.slice(7) : filePath;
    if (!isRemoteImageUrl(rawPath) && existsSync(rawPath)) {
      updatedAt = Math.floor(statSync(rawPath).mtimeMs);
    }
  } catch {}

  const description = await describeImageWithChatModel(
    sdk,
    filePath,
    imageTitle,
    options?.timeoutMs,
    options?.prompt,
  );

  const { layoutDescription, meaningDescription } = splitImageDescription(
    description,
    imageTitle,
  );

  const chunk0Text = `# Image: ${imageTitle} (Visual Elements & Layout)\n${layoutDescription}`;
  const chunk1Text = `# Image: ${imageTitle} (Underlying Meaning)\n${meaningDescription}`;

  const contextualChunks: ContextualChunk[] = [
    {
      chunk_index: 0,
      chunk_type: "verbatim",
      text_content: chunk0Text,
    },
    {
      chunk_index: 1,
      chunk_type: "synthetic",
      text_content: chunk1Text,
    },
  ];

  return {
    filePath,
    imageTitle,
    imageUri,
    updatedAt,
    description,
    layoutDescription,
    meaningDescription,
    contextualChunk: contextualChunks[0],
    contextualChunks,
  };
}

/**
 * Processes a batch of image files adhering strictly to the Two-Phase Local GPU Optimization Pattern:
 * Phase 1 (Chat Model Only): Parses all images, generates descriptions and builds contextual chunks (Zero embeddings).
 * Phase 2 (Embedding Model Only): If deferEmbedding is false, batch embeds all generated chunks in a single GPU call (Zero chat calls).
 * Exactly 1 GPU model transition occurs across the entire batch.
 */
export async function processImageFilesBatch(
  request: ProcessFilesBatchRequest,
  sdkOverride?: ShaleSDK,
): Promise<ProcessFilesBatchResponse> {
  const sdk = sdkOverride ?? getSDK();

  // Normalize batch items
  const items: ProcessFilesBatchItem[] = [];
  if (Array.isArray(request.files)) {
    for (const item of request.files) {
      if (typeof item === "string") {
        items.push({
          filePath: item,
          fileType: request.fileType ?? "image",
          contextEntity: request.contextEntity,
          options: request.options,
        });
      } else if (item && typeof item === "object") {
        items.push({
          ...item,
          fileType: item.fileType ?? request.fileType ?? "image",
          contextEntity: item.contextEntity ?? request.contextEntity,
          options: { ...request.options, ...item.options },
        });
      }
    }
  } else if (Array.isArray(request.filePaths)) {
    for (const fp of request.filePaths) {
      items.push({
        filePath: fp,
        fileType: request.fileType ?? "image",
        contextEntity: request.contextEntity,
        options: request.options,
      });
    }
  }

  if (items.length === 0) {
    return {
      success: true,
      totalProcessed: 0,
      totalFailed: 0,
      results: [],
    };
  }

  sdk.logger.info(
    `[process-image] [Phase 1: Chat Model] Batch parsing ${items.length} image file(s) with Chat model...`,
  );

  const results: ProcessFileResponse[] = [];
  const errors: Array<{ filePath: string; error: string }> = [];

  const settings = sdk.settings.getAll<ProcessImageSettings>();
  const entityType = settings?.defaultEntityType ?? "Image";
  const relation = settings?.defaultRelation ?? "IN_SAME_VAULT";

  // Phase 1: Chat Model Only across all images (Zero embeddings)
  for (const item of items) {
    const rawPath = item.filePath.startsWith("file://")
      ? item.filePath.slice(7)
      : item.filePath;
    try {
      const parsed = await parseImageFile(rawPath, sdk, {
        timeoutMs: item.options?.timeoutMs,
        prompt: item.options?.customPrompt,
      });

      const entities: ProcessedEntity[] = [
        {
          name: parsed.imageTitle,
          type: entityType,
          namespace: item.options?.namespace,
        },
      ];

      const edges: ProcessedEdge[] = [];
      const contextEntity = item.contextEntity ?? request.contextEntity;
      if (contextEntity) {
        edges.push({
          source: parsed.imageTitle,
          target: contextEntity,
          relation,
        });
      }

      const chunks: ProcessedChunk[] = parsed.contextualChunks.map((c) => ({
        chunk_index: c.chunk_index,
        chunk_type: c.chunk_type,
        text_content: c.text_content,
        entity_names: [parsed.imageTitle],
        embedding:
          c.chunk_index === 0 && item.options?.precomputedEmbedding
            ? item.options.precomputedEmbedding
            : undefined,
      }));

      results.push({
        success: true,
        filePath: item.filePath,
        fileType: "image",
        title: parsed.imageTitle,
        uri: parsed.imageUri,
        description: parsed.description,
        chunks,
        entities,
        edges,
        metadata: {
          updatedAt: parsed.updatedAt,
        },
      });
    } catch (err: any) {
      sdk.logger.error(`Error parsing image ${item.filePath} in Phase 1:`, err);
      errors.push({
        filePath: item.filePath,
        error: err?.message || String(err),
      });
      const title = imageDisplayName(item.filePath);
      results.push({
        success: false,
        filePath: item.filePath,
        fileType: "image",
        title,
        uri: isRemoteImageUrl(item.filePath)
          ? item.filePath
          : item.filePath.startsWith("file://")
          ? item.filePath
          : `file://${item.filePath}`,
        chunks: [],
        entities: [],
        edges: [],
        error: err?.message || String(err),
      });
    }
  }

  sdk.logger.info(
    `[process-image] [Phase 1: Chat Model] Completed parsing of ${results.length} image(s). (Zero embeddings performed)`,
  );

  const deferEmbedding = request.options?.deferEmbedding ?? false;
  if (deferEmbedding) {
    return {
      success: errors.length === 0,
      totalProcessed: results.filter((r) => r.success).length,
      totalFailed: errors.length,
      results,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  // Phase 2: Embedding Model Only across all generated chunks (Zero Chat calls)
  const chunksToEmbed: Array<{ chunk: ProcessedChunk }> = [];
  const textsToEmbed: string[] = [];

  for (const res of results) {
    if (!res.success) continue;
    for (const chunk of res.chunks) {
      if (!chunk.embedding) {
        chunksToEmbed.push({ chunk });
        textsToEmbed.push(chunk.text_content);
      }
    }
  }

  if (textsToEmbed.length > 0) {
    sdk.logger.info(
      `[process-image] [Phase 2: Embedding Model] Batch embedding ${textsToEmbed.length} chunk(s) across ${results.length} image(s)...`,
    );

    try {
      const embeddings = await sdk.embed(textsToEmbed);
      if (Array.isArray(embeddings)) {
        for (let i = 0; i < chunksToEmbed.length; i++) {
          chunksToEmbed[i].chunk.embedding = embeddings[i];
        }
      }
      sdk.logger.info(
        `[process-image] [Phase 2: Embedding Model] Completed batch embedding of ${textsToEmbed.length} chunk(s). (Zero chat calls performed in Phase 2)`,
      );
    } catch (embErr) {
      sdk.logger.warn(
        `[process-image] Failed to batch embed chunks in Phase 2:`,
        embErr,
      );
    }
  }

  return {
    success: errors.length === 0,
    totalProcessed: results.filter((r) => r.success).length,
    totalFailed: errors.length,
    results,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Unified processor handler for the built-in "file:process" channel when given an image.
 */
export async function processImageFile(
  request: ProcessFileRequest,
  sdkOverride?: ShaleSDK,
): Promise<ProcessFileResponse> {
  const sdk = sdkOverride ?? getSDK();

  // If bulk payload is passed, delegate to processImageFilesBatch
  if (
    (Array.isArray(request.files) && request.files.length > 0) ||
    (Array.isArray(request.filePaths) && request.filePaths.length > 0)
  ) {
    const batchResp = await processImageFilesBatch(
      {
        files: request.files,
        filePaths: request.filePaths,
        fileType: request.fileType,
        contextEntity: request.contextEntity,
        options: request.options,
      },
      sdk,
    );

    const firstSuccess =
      batchResp.results.find((r) => r.success) ?? batchResp.results[0];
    return {
      success: batchResp.success,
      filePath: firstSuccess?.filePath ?? (request.filePath || ""),
      fileType: "image",
      title: firstSuccess?.title ?? "Batch Images",
      uri: firstSuccess?.uri ?? "",
      description: firstSuccess?.description,
      chunks: firstSuccess?.chunks ?? [],
      entities: firstSuccess?.entities ?? [],
      edges: firstSuccess?.edges ?? [],
      results: batchResp.results,
      totalProcessed: batchResp.totalProcessed,
      totalFailed: batchResp.totalFailed,
      error: batchResp.errors?.[0]?.error,
    };
  }

  const filePath = request.filePath || "";
  const rawPath = filePath.startsWith("file://") ? filePath.slice(7) : filePath;

  try {
    // Phase 1: Chat model only (Zero embeddings)
    const parsed = await parseImageFile(rawPath, sdk, {
      timeoutMs: request.options?.timeoutMs,
      prompt: request.options?.customPrompt,
    });

    const settings = sdk.settings.getAll<ProcessImageSettings>();
    const entityType = settings?.defaultEntityType ?? "Image";
    const relation = settings?.defaultRelation ?? "IN_SAME_VAULT";

    const entities: ProcessedEntity[] = [
      {
        name: parsed.imageTitle,
        type: entityType,
        namespace: request.options?.namespace,
      },
    ];

    const edges: ProcessedEdge[] = [];
    if (request.contextEntity) {
      edges.push({
        source: parsed.imageTitle,
        target: request.contextEntity,
        relation,
      });
    }

    const chunks: ProcessedChunk[] = parsed.contextualChunks.map(
      (ctxChunk) => ({
        chunk_index: ctxChunk.chunk_index,
        chunk_type: ctxChunk.chunk_type,
        text_content: ctxChunk.text_content,
        entity_names: [parsed.imageTitle],
        embedding:
          ctxChunk.chunk_index === 0 && request.options?.precomputedEmbedding
            ? request.options.precomputedEmbedding
            : undefined,
      }),
    );

    // Phase 2: Embedding model only (Zero chat calls)
    if (!request.options?.deferEmbedding) {
      const chunksNeedingEmbedding = chunks.filter((c) => !c.embedding);
      if (chunksNeedingEmbedding.length > 0) {
        try {
          const texts = chunksNeedingEmbedding.map((c) => c.text_content);
          const embeddings = await sdk.embed(texts);
          if (Array.isArray(embeddings)) {
            for (let i = 0; i < chunksNeedingEmbedding.length; i++) {
              chunksNeedingEmbedding[i].embedding = embeddings[i];
            }
          }
        } catch (embErr) {
          sdk.logger.warn(
            `Could not generate immediate embeddings for image ${parsed.imageTitle}:`,
            embErr,
          );
        }
      }
    }

    return {
      success: true,
      filePath,
      fileType: "image",
      title: parsed.imageTitle,
      uri: parsed.imageUri,
      description: parsed.description,
      chunks,
      entities,
      edges,
      metadata: {
        updatedAt: parsed.updatedAt,
      },
    };
  } catch (err: any) {
    sdk.logger.error(`Error processing image file ${filePath}:`, err);
    const title = basename(filePath);
    return {
      success: false,
      filePath,
      fileType: "image",
      title,
      uri: filePath.startsWith("file://") ? filePath : `file://${filePath}`,
      chunks: [],
      entities: [],
      edges: [],
      error: err?.message || String(err),
    };
  }
}

export default processImageFile;
