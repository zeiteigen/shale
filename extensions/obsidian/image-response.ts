import { basename } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { ProcessFileResponse } from "../../lib/messages.types";
import type { ParsedImage } from "./parse-image";

/** Preserve the service's source identity and provenance when accepting its result. */
export function parsedImageResponse(response: ProcessFileResponse, filePath: string): ParsedImage {
  if (!response.success) throw new Error(response.error ?? `Image processing failed: ${filePath}`);
  const imageTitle = response.title || basename(filePath);
  const contextualChunks = response.chunks?.length
    ? response.chunks.map(chunk => ({ ...chunk, chunk_type: chunk.chunk_type ?? "synthetic" as const }))
    : [{ chunk_index: 0, chunk_type: "synthetic" as const,
      text_content: `# Image: ${imageTitle}\n${response.description ?? ""}` }];
  return {
    filePath, imageTitle, imageUri: response.uri || `file://${filePath}`,
    updatedAt: response.metadata?.updatedAt ?? (existsSync(filePath) ? Math.floor(statSync(filePath).mtimeMs) : Date.now()),
    description: response.description ?? "", knowledge: response.knowledge,
    assetHash: response.metadata?.assetHash, contextualChunk: contextualChunks[0], contextualChunks,
  };
}
