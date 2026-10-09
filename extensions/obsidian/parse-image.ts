import { getSDK, type ShaleSDK } from "@shale/sdk";
import { parsedImageResponse } from "./image-response";
import type { ProcessFileResponse } from "../../lib/messages.types";
import type { PreparedSourceClaim } from "../../sdk/graph/prepared";
import type { ContextualChunk } from "./parse-file";
import {
  describeImageWithChatModel as sharedDescribeImage,
  parseImageFile as sharedParseImageFile,
} from "../../sdk/media/image";

export interface ParsedImage {
  filePath: string;
  imageTitle: string;
  imageUri: string;
  updatedAt: number;
  description: string;
  knowledge?: PreparedSourceClaim[];
  assetHash?: string;
  contextualChunk: ContextualChunk;
  contextualChunks: ContextualChunk[];
}

export interface ParseImageOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Prompts the SDK Chat model to generate a comprehensive multimodal description.
 * Shared with the image service through the standalone SDK implementation.
 */
export async function describeImageWithChatModel(
  sdk: ShaleSDK,
  imagePath: string,
  imageName: string,
  timeoutMs?: number,
): Promise<string> {
  return sharedDescribeImage(sdk, imagePath, imageName, timeoutMs);
}

/**
 * Parses an image file in the vault, extracting metadata and using the cross-extension
 * message bus "file:process" channel provided by the process-image extension.
 *
 * Falls back to local image processor if running standalone or if message handler is not yet registered.
 */
export async function parseImageFile(
  filePath: string,
  sdkOverride?: ShaleSDK,
  options?: ParseImageOptions,
): Promise<ParsedImage> {
  const sdk = sdkOverride ?? getSDK();
  const rawPath = filePath.startsWith("file://") ? filePath.slice(7) : filePath;
  if (sdk.messages.hasHandler("file:process")) {
    // Model calls have their own deadlines. A fixed bus deadline also counts queue
    // time and would abort a valid model request before its configured timeout.
    const response = await sdk.messages.request("file:process", {
      filePath: rawPath, fileType: "image",
      options: { timeoutMs: options?.timeoutMs },
    }, { timeoutMs: 0, signal: options?.signal });
    return parsedImageResponse(response, rawPath);
  }

  // 2. Standalone fallback using the SDK implementation
  const localResult = await sharedParseImageFile(rawPath, sdk, { ...options, requireDescription: true });
  const contextualChunks: ContextualChunk[] = localResult.contextualChunks.map(
    (c) => ({
      chunk_index: c.chunk_index,
      chunk_type: c.chunk_type,
      text_content: c.text_content,
      metadata: c.metadata,
    }),
  );

  return {
    filePath: localResult.filePath,
    imageTitle: localResult.imageTitle,
    imageUri: localResult.imageUri,
    updatedAt: localResult.updatedAt,
    description: localResult.description,
    assetHash: localResult.assetHash,
    knowledge: localResult.contextualChunks.map(c => ({ predicate: String(c.metadata?.predicate ?? "VISUAL_DESCRIPTION"), value: c.text_content, chunkIndex: c.chunk_index, status: "proposed", method: String(c.metadata?.origin ?? "vision"), model: c.metadata?.model as string | undefined })),
    contextualChunk: contextualChunks[0],
    contextualChunks,
  };
}

/**
 * Parses a batch of image files.
 * Uses the cross-extension message bus "files:process" or "file:process" bulk channels
 * Standalone execution is used when no handler exists.
 */
export async function parseImageFilesBatch(
  filePaths: string[],
  sdkOverride?: ShaleSDK,
  options?: ParseImageOptions,
): Promise<ParsedImage[]> {
  const sdk = sdkOverride ?? getSDK();
  if (!filePaths || filePaths.length === 0) return [];

  const rawPaths = filePaths.map((fp) =>
    fp.startsWith("file://") ? fp.slice(7) : fp,
  );

  const bulkChannel = sdk.messages.hasHandler("files:process")
    ? "files:process" : sdk.messages.hasHandler("file:process") ? "file:process" : null;
  if (bulkChannel) {
    const response = await sdk.messages.request<{ results?: ProcessFileResponse[] } & Partial<ProcessFileResponse>, any>(bulkChannel, {
      filePaths: rawPaths, fileType: "image",
      options: { timeoutMs: options?.timeoutMs },
    }, { timeoutMs: 0, signal: options?.signal });
    const results = response.results ?? (rawPaths.length === 1 ? [response as ProcessFileResponse] : []);
    const byPath = new Map(results.map(result => [result.filePath.replace(/^file:\/\//, ""), result]));
    const parsed: ParsedImage[] = [];
    for (const filePath of rawPaths) {
      const result = byPath.get(filePath);
      if (result?.success) parsed.push(parsedImageResponse(result, filePath));
      else sdk.logger.warn(`Image remains pending for retry: ${filePath}: ${result?.error ?? "No image result returned"}`);
    }
    return parsed;
  }

  // Standalone parsing only runs when no processor is registered. Keep successful
  // items if another image fails; a subsequent scan will retry the missing items.
  const results = await sdk.models.mapChat(rawPaths, async filePath => {
    try { return await parseImageFile(filePath, sdk, options); }
    catch (error) {
      options?.signal?.throwIfAborted();
      sdk.logger.warn(`Image remains pending for retry: ${filePath}: ${error}`);
      return undefined;
    }
  });
  return results.filter((result): result is ParsedImage => result !== undefined);
}

export default parseImageFile;
