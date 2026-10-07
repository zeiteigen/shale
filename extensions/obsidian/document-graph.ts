import { SourceGraph, type GraphValue, type ShaleSDK } from "@shale/sdk";
import { commitPreparedClaims } from "../../sdk/graph/prepared";
import { linkVaultMembership, type VaultContext } from "./graph";
import type { ParsedDocument } from "./parse-document";

export function commitDocumentGraph(
  sdk: ShaleSDK, sourceId: string, namespace: string,
  document: ParsedDocument, vault: VaultContext,
): SourceGraph {
  const graph = new SourceGraph(sdk.database, sdk.graph, sourceId, namespace, document.updatedAt);
  const entity = graph.entity(document.documentUri, document.documentTitle, "Document");
  linkVaultMembership(graph, entity, vault);
  graph.claim(entity, "SOURCE_URI", { value: document.documentUri });
  graph.claim(entity, "TITLE", { value: document.documentTitle });
  if (document.assetHash) graph.claim(entity, "ASSET_SHA256", { value: document.assetHash });
  graph.claim(entity, "DOCUMENT_METADATA", {
    value: JSON.parse(JSON.stringify(document.metadata)) as GraphValue,
  }, { method: "document-parser" });
  for (const chunk of document.contextualChunks) {
    if (!chunk.metadata) continue;
    const location = Object.fromEntries(
      ["pageNumber", "slideNumber", "sheetName", "closestHeading"]
        .filter(key => chunk.metadata![key] !== undefined).map(key => [key, chunk.metadata![key]]),
    );
    if (Object.keys(location).length) {
      graph.claim(entity, "CHUNK_LOCATION", { value: location as GraphValue }, {
        method: "document-parser", evidence: graph.evidence(chunk.chunk_index),
      });
    }
  }
  commitPreparedClaims(graph, entity, document.knowledge);
  return graph;
}
