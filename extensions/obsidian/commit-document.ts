import type { ShaleSDK } from "@shale/sdk";
import type { VaultContext } from "./graph";
import type { ParsedDocument } from "./parse-document";
import { commitDocumentGraph } from "./document-graph";
import { recordCommittedFile } from "./file-progress";
import { contentFingerprint, memoryChunks, prepareSourceMemory } from "../../lib/memory/prepare";
import { compactParsedDocument } from "./memory";

/** Commit source, graph evidence, and checkpoint deletion in one transaction. */
export function commitDocument(
  sdk: ShaleSDK, document: ParsedDocument,
  vault: VaultContext, namespace = "obsidian", checkpointId?: string,
) {
  return sdk.database.transaction(() => {
    const memory = document.memory ?? prepareSourceMemory(document.contextualChunks, { title: document.documentTitle });
    document = { ...document, memory };
    document = compactParsedDocument(document);
    const result = sdk.ingest.sourceAndChunks({
      namespace,
      source: {
        type: "document", uri: document.documentUri, origin: "obsidian",
        title: document.documentTitle, updated_at: document.updatedAt,
        hash: document.sourceFingerprint ?? contentFingerprint(document.contextualChunks),
      },
      chunks: memoryChunks(memory), memory,
    });
    if (result.skipped) {
      if (checkpointId) sdk.deleteCheckpoint(checkpointId);
      return { ...result, edgesCreated: 0 };
    }
    const graph = commitDocumentGraph(sdk, result.sourceId, namespace, document, vault);
    recordCommittedFile(sdk, namespace, document.documentUri, document.updatedAt);
    if (checkpointId) sdk.deleteCheckpoint(checkpointId);
    return { ...result, edgesCreated: graph.edgesCount };
  })();
}
