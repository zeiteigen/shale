import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { SourceGraph, type ShaleSDK } from "@shale/sdk";
import { commitPreparedClaims } from "../../sdk/graph/prepared";
import { fileStateKey } from "./file-state";
import type { PreparedDirectoryFile } from "./types";

/** Source, graph evidence, file watermark, and checkpoint removal commit together. */
export function commitFile(sdk: ShaleSDK, id: string, file: PreparedDirectoryFile, embeddings: number[][]) {
  return sdk.database.transaction(() => {
    const { parsed, namespace } = file;
    const uri = pathToFileURL(file.filePath).href;
    const result = sdk.ingest.sourceAndChunks({ namespace,
      source: { type: parsed.fileType, uri, origin: "directories", title: parsed.title, updated_at: file.updatedAt,
        hash: createHash("sha256").update(JSON.stringify([uri, parsed.metadata?.assetHash ?? null,
          parsed.chunks.map(chunk => chunk.text_content)])).digest("hex") },
      chunks: parsed.chunks.map((chunk, index) => ({ text_content: chunk.text_content, chunk_index: index,
        chunk_type: chunk.chunk_type ?? "verbatim", embedding: embeddings[index] })),
    });
    const graph = new SourceGraph(sdk.database, sdk.graph, result.sourceId, namespace, file.updatedAt);
    const primary = parsed.entities.find(entity => entity.name === parsed.title);
    const subject = graph.entity(uri, parsed.title, primary?.type ?? (parsed.fileType === "image" ? "Image" : "Document"));
    const directory = graph.entity(pathToFileURL(file.directory.path).href, file.directory.name, "Directory");
    graph.link(subject, "IN_DIRECTORY", directory);
    graph.claim(subject, "SOURCE_URI", { value: uri });
    graph.claim(subject, "TITLE", { value: parsed.title });
    // Link every chunk to the file entity, including text with no extracted entities.
    for (let index = 0; index < parsed.chunks.length; index++) {
      graph.claim(subject, "HAS_CONTENT", { value: index }, { evidence: graph.evidence(index) });
    }
    const entities = new Map<string, number>([[parsed.title, subject]]);
    for (const entity of parsed.entities) {
      if (entities.has(entity.name)) continue;
      entities.set(entity.name, graph.entity(entity.identityKey ?? `${uri}#entity:${entity.type}:${entity.name}`, entity.name, entity.type));
    }
    for (const edge of parsed.edges) {
      const source = entities.get(edge.source);
      const target = entities.get(edge.target);
      if (source !== undefined && target !== undefined) graph.link(source, edge.relation, target, { strength: edge.weight });
    }
    commitPreparedClaims(graph, subject, parsed.knowledge ?? []);
    sdk.state.setWatermark(file.fingerprint, fileStateKey(namespace, file.filePath));
    sdk.checkpoint.delete(id);
    return result;
  })();
}
