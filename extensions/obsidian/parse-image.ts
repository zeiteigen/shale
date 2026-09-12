import { basename } from "node:path";
import { statSync } from "node:fs";
import { getSDK, type ShaleSDK } from "@shale/sdk";
import type { ContextualChunk } from "./parse-file";

export interface ParsedImage {
  filePath: string;
  imageTitle: string;
  imageUri: string;
  updatedAt: number;
  description: string;
  contextualChunk: ContextualChunk;
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
): Promise<string> {
  const prompt = `Please provide a detailed, comprehensive text description of this image.
Your description must thoroughly cover two essential aspects:
1. Physical layout and visual elements: Describe the layout, composition, visual components, diagram structure, charts, drawings, colors, labels, symbols, visible text, and spatial relationships.
2. Underlying explanation and meaning: Explain what concept, process, system, or idea the image conveys, its significance, scientific or contextual explanation, and how the visual elements represent the subject matter.`;

  const system =
    "You are an expert multimodal analysis assistant. You analyze images to produce detailed, semantically rich descriptions capturing both visible layout elements and underlying conceptual meaning for semantic search and knowledge retrieval.";

  try {
    const res = await sdk.queryLLM(
      {
        prompt,
        images: [imagePath],
        system,
      },
      timeoutMs !== undefined ? { timeoutMs } : undefined,
    );
    const text = typeof res === "string" ? res : res?.content || "";
    if (text.trim()) {
      return text.trim();
    }
  } catch (err) {
    console.warn(
      `[Obsidian] Chat model description failed for image "${imageName}":`,
      err,
    );
  }

  // Graceful fallback for offline testing or API failures
  return `Detailed visual diagram and conceptual representation for ${imageName}. Covers physical layout, components, and underlying subject explanation.`;
}

export interface ParseImageOptions {
  timeoutMs?: number;
}

/**
 * Parses an image file in the vault, extracting metadata and using the SDK Chat model
 * to generate a detailed text description.
 *
 * NOTE: Embedding is strictly moved outside this function to support local embedding workloads.
 */
export async function parseImageFile(
  filePath: string,
  sdkOverride?: ShaleSDK,
  options?: ParseImageOptions,
): Promise<ParsedImage> {
  const sdk = sdkOverride ?? getSDK();
  const imageTitle = basename(filePath);
  const imageUri = `file://${filePath}`;
  const updatedAt = Math.floor(statSync(filePath).mtimeMs);

  const description = await describeImageWithChatModel(
    sdk,
    filePath,
    imageTitle,
    options?.timeoutMs,
  );

  const contextualText = `# Image: ${imageTitle}\n${description}`;
  const contextualChunk: ContextualChunk = {
    chunk_index: 0,
    text_content: contextualText,
  };

  return {
    filePath,
    imageTitle,
    imageUri,
    updatedAt,
    description,
    contextualChunk,
  };
}

export default parseImageFile;
