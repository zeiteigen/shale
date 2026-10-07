import type { Database } from "bun:sqlite";
import { graphIdentityFromSourceUri } from "../lib/source-identity";

export interface GraphSource { id: string; uri: string; title: string }

/** Resolve connector identities before display labels, including duplicate titles. */
export function sourceMap(db: Database, sources: GraphSource[]): Map<number, GraphSource> {
  const byId = new Map(sources.map(source => [source.id, source]));
  const byUri = new Map<string, GraphSource>();
  for (const source of sources) {
    const key = graphIdentityFromSourceUri(source.uri);
    if (!byUri.has(key) || /^https?:/.test(source.uri)) byUri.set(key, source);
  }
  const result = new Map<number, GraphSource>();
  const aliases = db.query<{entity_id: number; alias: string; scope: string}, []>(
    "SELECT entity_id,alias,scope FROM graph_aliases WHERE scope IN ('source-id','connector-key') ORDER BY CASE scope WHEN 'source-id' THEN 0 ELSE 1 END,entity_id,alias",
  ).all();
  for (const alias of aliases) {
    const source = alias.scope === "source-id" ? byId.get(alias.alias) : byUri.get(graphIdentityFromSourceUri(alias.alias));
    if (source && !result.has(alias.entity_id)) result.set(alias.entity_id, source);
  }
  return result;
}
