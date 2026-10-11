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
  commitPreparedClaims(graph, entity, document.knowledge);
  return graph;
}
