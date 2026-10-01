import { basename } from "node:path";
import { statSync, existsSync } from "node:fs";
import { getSDK, logger, getSetting, type ShaleSDK } from "@shale/sdk";

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
        : new Set(
            customExtensions.map((e) => e.toLowerCase().replace(/^\./, "")),
          );
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

export function isRemoteImageUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function imageDisplayName(value: string): string {
  if (isRemoteImageUrl(value)) {
    try {
      return basename(new URL(value).pathname) || new URL(value).hostname;
    } catch {}
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
  signal?: AbortSignal,
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
      : (sdk?.settings.get<number>("imageTimeoutMs") ??
        getSetting<number>("imageTimeoutMs"));

  try {
    const res = await sdk.queryLLM(
      {
        prompt,
        images: [imagePath],
        system,
      },
      { timeoutMs: effectiveTimeout, signal },
    );

    return res.trim();
  } catch (err) {
    signal?.throwIfAborted();
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
  options?: { timeoutMs?: number; prompt?: string; signal?: AbortSignal },
): Promise<ParsedImageInfo> {
  const sdk = sdkOverride ?? getSDK();
  const imageTitle = imageDisplayName(filePath);
  const imageUri = isRemoteImageUrl(filePath)
    ? filePath
    : filePath.startsWith("file://")
      ? filePath
      : `file://${filePath}`;
  let updatedAt = Date.now();

  try {
    const rawPath = filePath.startsWith("file://")
      ? filePath.slice(7)
      : filePath;
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
    options?.signal,
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
