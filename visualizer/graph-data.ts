import type { ShaleSDK } from "../sdk";
import { sourceIdFromEntity, graphIdentityFromSourceUri } from "../lib/source-identity";

export interface GraphData {
  nodes: Array<{
    id: number;
    name: string;
    type: string;
    namespace: string;
    degree: number;
    sourceUri?: string;
    sourceTitle?: string;
    chunksCount: number;
    chunks: Array<{ id: number; chunk_index: number; text_content: string }>;
  }>;
  edges: Array<{ source: number; target: number; relation: string; weight: number }>;
  stats: { totalEntities: number; totalEdges: number; totalSources: number; totalChunks: number };
}

export function getGraphData(sdk: ShaleSDK): GraphData {
  const db = sdk.database;
  const entities = db.query<{ id: number; namespace: string; name: string; type: string }, []>(
    "SELECT id, namespace, name, type FROM entities ORDER BY id ASC",
  ).all();
  const edges = db.query<{
    source_entity_id: number;
    target_entity_id: number;
    relation: string;
    weight: number;
  }, []>("SELECT source_entity_id, target_entity_id, relation, weight FROM edges").all();
  const sources = db.query<{ id: string; uri: string; title: string }, []>(
    "SELECT id, uri, title FROM sources",
  ).all();
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const sourceByTitle = new Map<string, (typeof sources)[number]>();
  const ambiguousTitles = new Set<string>();
  for (const source of sources) {
    const title = source.title.toLowerCase();
    if (sourceByTitle.has(title)) ambiguousTitles.add(title);
    sourceByTitle.set(title, source);
  }
  for (const title of ambiguousTitles) sourceByTitle.delete(title);
  const sourceByUri = new Map<string, (typeof sources)[number]>();
  for (const source of sources) {
    const identity = graphIdentityFromSourceUri(source.uri);
    // Rich web-page sources are queried first and remain the preferred material
    // when history/bookmark metadata points at the same page node.
    if (!sourceByUri.has(identity) || /^https?:\/\//.test(source.uri)) {
      sourceByUri.set(identity, source);
    }
  }
  const degree = new Map<number, number>();

  for (const edge of edges) {
    degree.set(edge.source_entity_id, (degree.get(edge.source_entity_id) || 0) + 1);
    degree.set(edge.target_entity_id, (degree.get(edge.target_entity_id) || 0) + 1);
  }

  return {
    nodes: entities.map((entity) => {
      const sourceId = sourceIdFromEntity(entity.name);
      const source = sourceId ? sourceById.get(sourceId)
        : sourceByUri.get(entity.name) ?? sourceByTitle.get(entity.name.toLowerCase());
      const chunks = source ? sdk.context.getRecentChunks(source.id, 5) : [];
      return {
        ...entity,
        name: sourceId && source ? source.title : entity.name,
        degree: degree.get(entity.id) || 0,
        sourceUri: source?.uri,
        sourceTitle: source?.title,
        chunksCount: chunks.length,
        chunks,
      };
    }),
    edges: edges.map((edge) => ({
      source: edge.source_entity_id,
      target: edge.target_entity_id,
      relation: edge.relation,
      weight: edge.weight,
    })),
    stats: {
      totalEntities: entities.length,
      totalEdges: edges.length,
      totalSources: db.query<{ count: number }, []>("SELECT count(*) AS count FROM sources").get()?.count || 0,
      totalChunks: db.query<{ count: number }, []>("SELECT count(*) AS count FROM chunks").get()?.count || 0,
    },
  };
}

