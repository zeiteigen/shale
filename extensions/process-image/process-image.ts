import { getSDK, type ShaleSDK } from "@shale/sdk";
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

import {
  parseImageFile,
  isRemoteImageUrl,
  imageDisplayName,
} from "./parse-image";
export {
  canProcessImage,
  DEFAULT_IMAGE_EXTENSIONS,
  describeImageWithChatModel,
  parseImageFile,
  splitImageDescription,
  type ParsedImageInfo,
  type ContextualChunk,
  type SplitImageDescription,
} from "./parse-image";

/**
 * Process images as a chat batch and return descriptions and contextual chunks.
 */
export async function processImageFilesBatch(
  request: ProcessFilesBatchRequest,
  sdkOverride?: ShaleSDK,
  signal?: AbortSignal,
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

  sdk.logger.info(`[process-image] Batch parsing ${items.length} image file(s) with Chat model...`);

  const results: ProcessFileResponse[] = [];
  const errors: Array<{ filePath: string; error: string }> = [];

  const settings = sdk.settings.getAll<ProcessImageSettings>();
  const entityType = settings?.defaultEntityType ?? "Image";
  const relation = settings?.defaultRelation ?? "CONTAINED_IN";

  const prepare = async () => {
    await sdk.models.mapChat(items, async (item, index) => {
      signal?.throwIfAborted();
      const rawPath = item.filePath.startsWith("file://")
        ? item.filePath.slice(7)
        : item.filePath;
      try {
        const parsed = await parseImageFile(rawPath, sdk, {
          timeoutMs: item.options?.timeoutMs,
          prompt: item.options?.customPrompt,
          signal,
          requireDescription: true,
        });

        const entities: ProcessedEntity[] = [
          {
            name: parsed.imageTitle,
            identityKey: parsed.imageUri,
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
          metadata: c.metadata,
        }));

        results[index] = {
          success: true,
          filePath: item.filePath,
          fileType: "image",
          title: parsed.imageTitle,
          uri: parsed.imageUri,
          description: parsed.description,
          knowledge: parsed.contextualChunks.map(chunk => ({
            predicate: String(chunk.metadata?.predicate ?? "VISUAL_DESCRIPTION"),
            value: chunk.text_content, chunkIndex: chunk.chunk_index,
            status: "proposed", method: String(chunk.metadata?.origin ?? "vision"), model: chunk.metadata?.model as string | undefined,
          })),
          chunks,
          entities,
          edges,
          metadata: {
            updatedAt: parsed.updatedAt,
            assetHash: parsed.assetHash,
          },
        };
      } catch (err: any) {
        sdk.logger.error(
          `Error parsing image ${item.filePath}:`,
          err,
        );
        errors.push({
          filePath: item.filePath,
          error: err?.message || String(err),
        });
        const title = imageDisplayName(item.filePath);
        results[index] = {
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
        };
      }
    });

    sdk.logger.info(
      `[process-image] Parsed ${results.filter(result => result.success).length} image(s), ${errors.length} failed.`,
    );

    return results;
  };

  const response = (): ProcessFilesBatchResponse => ({
    success: errors.length === 0,
    totalProcessed: results.filter((result) => result.success).length,
    totalFailed: errors.length,
    results,
    errors: errors.length ? errors : undefined,
  });
  await prepare();
  return response();
}

/**
 * Unified processor handler for the built-in "file:process" channel when given an image.
 */
export async function processImageFile(
  request: ProcessFileRequest,
  sdkOverride?: ShaleSDK,
  signal?: AbortSignal,
): Promise<ProcessFileResponse> {
  const sdk = sdkOverride ?? getSDK();

  const batch = await processImageFilesBatch(
    {
      files:
        request.files ??
        (request.filePaths ? undefined : [request.filePath || ""]),
      filePaths: request.filePaths,
      fileType: request.fileType,
      contextEntity: request.contextEntity,
      options: request.options,
    },
    sdk,
    signal,
  );
  const first =
    batch.results.find((result) => result.success) ?? batch.results[0];
  return {
    success: batch.success,
    filePath: first?.filePath ?? request.filePath ?? "",
    fileType: "image",
    title: first?.title ?? "Batch Images",
    uri: first?.uri ?? "",
    description: first?.description,
    chunks: first?.chunks ?? [],
    entities: first?.entities ?? [],
    edges: first?.edges ?? [],
    metadata: first?.metadata,
    ...(request.files || request.filePaths
      ? {
          results: batch.results,
          totalProcessed: batch.totalProcessed,
          totalFailed: batch.totalFailed,
        }
      : {}),
    error: batch.errors?.[0]?.error,
  };
}

export default processImageFile;
