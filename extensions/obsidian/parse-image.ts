import { basename } from "node:path";
import { statSync, existsSync } from "node:fs";
import { getSDK, logger, type ShaleSDK } from "@shale/sdk";
import type { ContextualChunk } from "./parse-file";
import {
  describeImageWithChatModel as sharedDescribeImage,
  parseImageFile as sharedParseImageFile,
} from "../process-image/process-image";

export interface ParsedImage {
  filePath: string;
  imageTitle: string;
  imageUri: string;
  updatedAt: number;
  description: string;
  contextualChunk: ContextualChunk;
  contextualChunks: ContextualChunk[];
}

export interface ParseImageOptions {
  timeoutMs?: number;
}

/**
 * Prompts the SDK Chat model to generate a comprehensive multimodal description.
 * Re-exported from the dedicated process-image extension.
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
  const imageTitle = basename(rawPath);
  const imageUri = filePath.startsWith("file://") ? filePath : `file://${filePath}`;
  let updatedAt = Date.now();
  try {
    if (existsSync(rawPath)) {
      updatedAt = Math.floor(statSync(rawPath).mtimeMs);
    }
  } catch {}

  // 1. First attempt via cross-extension messaging "file:process"
  if (sdk?.messages?.hasHandler("file:process")) {
    try {
      const resp = await sdk.messages.request("file:process", {
        filePath: rawPath,
        fileType: "image",
        options: {
          timeoutMs: options?.timeoutMs,
          deferEmbedding: true,
        },
      });

      if (resp && resp.success) {
        const contextualChunks: ContextualChunk[] =
          resp.chunks && resp.chunks.length > 0
            ? resp.chunks.map((c) => ({
                chunk_index: c.chunk_index,
                chunk_type:
                  c.chunk_type ??
                  (c.chunk_index === 0 ? "verbatim" : "synthetic"),
                text_content: c.text_content,
              }))
            : [
                {
                  chunk_index: 0,
                  chunk_type: "verbatim",
                  text_content: `# Image: ${resp.title}\n${resp.description ?? ""}`,
                },
              ];

        return {
          filePath: rawPath,
          imageTitle: resp.title || imageTitle,
          imageUri: resp.uri || imageUri,
          updatedAt: resp.metadata?.updatedAt ?? updatedAt,
          description: resp.description ?? "",
          contextualChunk: contextualChunks[0],
          contextualChunks,
        };
      }
    } catch (err: any) {
      (sdk?.logger ?? logger).warn(
        `Cross-extension "file:process" message call failed, falling back to local processor: ${err?.message || err}`,
      );
    }
  }

  // 2. Local fallback using process-image logic
  const localResult = await sharedParseImageFile(rawPath, sdk, options);
  const contextualChunks: ContextualChunk[] = localResult.contextualChunks.map(
    (c) => ({
      chunk_index: c.chunk_index,
      chunk_type: c.chunk_type,
      text_content: c.text_content,
    }),
  );

  return {
    filePath: localResult.filePath,
    imageTitle: localResult.imageTitle,
    imageUri: localResult.imageUri,
    updatedAt: localResult.updatedAt,
    description: localResult.description,
    contextualChunk: contextualChunks[0],
    contextualChunks,
  };
}

/**
 * Parses a batch of image files adhering to Phase 1 of the two-phase system (Zero embeddings).
 * Uses the cross-extension message bus "files:process" or "file:process" bulk channels
 * with deferEmbedding: true, falling back to local batch execution.
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

  // 1. First attempt via cross-extension messaging bulk channels
  const bulkChannel = sdk?.messages?.hasHandler("files:process")
    ? "files:process"
    : sdk?.messages?.hasHandler("file:process")
      ? "file:process"
      : null;

  if (bulkChannel) {
    try {
      const resp = await sdk.messages.request<any, any>(bulkChannel, {
        filePaths: rawPaths,
        fileType: "image",
        options: {
          timeoutMs: options?.timeoutMs,
          deferEmbedding: true,
        },
      });

      const batchResults = resp?.results || (resp?.success ? [resp] : []);
      if (Array.isArray(batchResults) && batchResults.length > 0) {
        return batchResults.map((item: any, idx: number) => {
          const rawPath = rawPaths[idx] || item.filePath;
          const imageTitle = item.title || basename(rawPath);
          const imageUri = item.uri || (rawPath.startsWith("file://") ? rawPath : `file://${rawPath}`);
          let updatedAt = Date.now();
          try {
            if (existsSync(rawPath)) {
              updatedAt = Math.floor(statSync(rawPath).mtimeMs);
            }
          } catch {}

          const contextualChunks: ContextualChunk[] =
            item.chunks && item.chunks.length > 0
              ? item.chunks.map((c: any) => ({
                  chunk_index: c.chunk_index,
                  chunk_type:
                    c.chunk_type ??
                    (c.chunk_index === 0 ? "verbatim" : "synthetic"),
                  text_content: c.text_content,
                }))
              : [
                  {
                    chunk_index: 0,
                    chunk_type: "verbatim",
                    text_content: `# Image: ${imageTitle}\n${item.description ?? ""}`,
                  },
                ];

          return {
            filePath: rawPath,
            imageTitle,
            imageUri,
            updatedAt: item.metadata?.updatedAt ?? updatedAt,
            description: item.description ?? "",
            contextualChunk: contextualChunks[0],
            contextualChunks,
          };
        });
      }
    } catch (err: any) {
      (sdk?.logger ?? logger).warn(
        `Cross-extension bulk messaging failed, falling back to local parser: ${err?.message || err}`,
      );
    }
  }

  // 2. Local fallback
  const results: ParsedImage[] = [];
  for (const fp of rawPaths) {
    const parsed = await parseImageFile(fp, sdk, options);
    results.push(parsed);
  }
  return results;
}

export default parseImageFile;
