import type { ShaleSDK } from "../sdk";
import { sourceIdFromEntity, graphIdentityFromSourceUri } from "../lib/source-identity";
import type { ClaimFilter, ClaimStatus } from "../sdk/graph/types";
import { sourceMap } from "./source-map";
import { graphEdges } from "./graph-edges";
import { recentChunksBySource } from './recent-chunks';

export interface GraphData {
  nodes: Array<{
    id: number;
    name: string;
    type: string;
    namespace: string;
    stableId: string;
    canonicalId: number | null;
    degree: number;
    sourceUri?: string;
    sourceTitle?: string;
    chunksCount: number;
    chunks: Array<{ id: number; chunk_index: number; text_content: string }>;
  }>;
  edges: Array<{ id: string; source: number; target: number; relation: string; weight: number; status: ClaimStatus; context?: string }>;
  truncated: boolean;
  stats: { totalEntities: number; totalEdges: number; totalSources: number; totalChunks: number; totalClaims: number };
}

export function getGraphData(sdk: ShaleSDK, filter: ClaimFilter = {}): GraphData {
  return sdk.database.transaction(() => graphSnapshot(sdk, filter))();
}

function graphSnapshot(sdk: ShaleSDK, filter: ClaimFilter): GraphData {
  const db = sdk.database;
  const entities = db.query<{ id: number; namespace: string; name: string; identityName: string; type: string; stableId:string;canonicalId:number|null }, []>(
    "SELECT id,namespace,name AS identityName,coalesce(display_name,name) AS name,type,stable_id AS stableId,canonical_id AS canonicalId FROM entities ORDER BY id ASC",
  ).all();
  const { claims, truncated } = graphEdges(sdk, filter);
  const edges=claims.filter(c=>c.object!==undefined).map(c=>({id:c.id,source_entity_id:c.subject,
    target_entity_id:c.object!,relation:c.predicate,weight:c.strength ?? 1,status:c.status,context:c.context}));
  const sources = db.query<{ id: string; uri: string; title: string }, []>(
    "SELECT id, uri, title FROM sources",
  ).all();
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const sourceByEntity = sourceMap(db, sources);
  const recentChunks=recentChunksBySource(db);
  const chunkCounts = new Map(db.query<{source_id: string; count: number}, []>(
    "SELECT source_id,count(*) AS count FROM chunks GROUP BY source_id",
  ).all().map(row => [row.source_id, row.count]));
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
      const { identityName, ...display } = entity;
      const sourceId = sourceIdFromEntity(identityName);
      const source = sourceByEntity.get(entity.id) ?? (sourceId ? sourceById.get(sourceId)
        : sourceByUri.get(identityName) ?? (!identityName.startsWith("entity:")
          ? sourceByTitle.get(entity.name.toLowerCase()) : undefined));
      const chunks = source ? recentChunks.get(source.id) ?? [] : [];
      return {
        ...display,
        name: sourceId && source ? source.title : entity.name,
        degree: degree.get(entity.id) || 0,
        sourceUri: source?.uri,
        sourceTitle: source?.title,
        chunksCount: source ? chunkCounts.get(source.id) ?? 0 : 0,
        chunks,
      };
    }),
    edges: edges.map((edge) => ({
      id:edge.id,status:edge.status,context:edge.context,
      source: edge.source_entity_id,
      target: edge.target_entity_id,
      relation: edge.relation,
      weight: edge.weight,
    })),
    stats: {
      totalClaims:db.query<{count:number}, []>('SELECT count(*) AS count FROM graph_claims').get()?.count || 0,
      totalEntities: entities.length,
      totalEdges: edges.length,
      totalSources: db.query<{ count: number }, []>("SELECT count(*) AS count FROM sources").get()?.count || 0,
      totalChunks: db.query<{ count: number }, []>("SELECT count(*) AS count FROM chunks").get()?.count || 0,
    },
    truncated,
  };
}
