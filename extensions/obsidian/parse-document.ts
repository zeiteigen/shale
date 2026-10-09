import { getSDK, type ShaleSDK } from "@shale/sdk";
import type { PreparedSourceClaim } from "../../sdk/graph/prepared";
import type { ContextualChunk } from "./parse-file";

export interface ParsedDocument {
  filePath: string;
  documentTitle: string;
  documentUri: string;
  updatedAt: number;
  assetHash?: string;
  metadata: Record<string, unknown>;
  knowledge: PreparedSourceClaim[];
  contextualChunks: ContextualChunk[];
}

/** Call the document service and return extracted text and graph metadata. */
export async function parseDocumentFile(
  filePath: string,
  sdkOverride?: ShaleSDK,
  namespace?: string,
): Promise<ParsedDocument> {
  const sdk = sdkOverride ?? getSDK();
  const response = await sdk.messages.request("file:process", {
    filePath,
    fileType: "document",
    options: { namespace: namespace ?? sdk.namespace },
  }, {
    target: "process-document",
    timeoutMs: sdk.settings.get<number>("documentRequestTimeoutMs") ?? 180000,
  });
  if (!response.success || !response.chunks.length) {
    throw new Error(response.error ?? `No document chunks returned for ${filePath}`);
  }
  return {
    filePath,
    documentTitle: response.title,
    documentUri: response.uri,
    updatedAt: response.metadata?.updatedAt ?? Date.now(),
    assetHash: response.metadata?.assetHash,
    metadata: response.metadata ?? {},
    knowledge: response.knowledge ?? [],
    contextualChunks: response.chunks.map(chunk => ({
      chunk_index: chunk.chunk_index,
      chunk_type: chunk.chunk_type ?? "verbatim",
      text_content: chunk.text_content,
      metadata: chunk.metadata,
    })),
  };
}
