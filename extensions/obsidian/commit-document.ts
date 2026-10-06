import { createHash } from "node:crypto";
import type { ShaleSDK } from "@shale/sdk";
import type { VaultContext } from "./graph";
import type { ParsedDocument } from "./parse-document";
import { commitDocumentGraph } from "./document-graph";

/** Commit source, graph evidence, and checkpoint deletion in one transaction. */
export function commitDocument(
  sdk: ShaleSDK, document: ParsedDocument, embeddings: number[][],
  vault: VaultContext, namespace = "obsidian", checkpointId?: string,
) {
  return sdk.database.transaction(() => {
    const result = sdk.ingest.sourceAndChunks({
      namespace,
      source: {
        type: "document", uri: document.documentUri, origin: "obsidian",
        title: document.documentTitle, updated_at: document.updatedAt,
        hash: createHash("sha256").update(JSON.stringify([
          document.documentUri, document.assetHash, document.metadata,
          document.contextualChunks.map(chunk => [chunk.text_content, chunk.chunk_type, chunk.metadata]),
        ])).digest("hex"),
      },
      chunks: document.contextualChunks.map((chunk, index) => ({ ...chunk, embedding: embeddings[index] })),
    });
    const graph = commitDocumentGraph(sdk, result.sourceId, namespace, document, vault);
    if (checkpointId) sdk.deleteCheckpoint(checkpointId);
    return { ...result, edgesCreated: graph.edgesCount };
  })();
}
