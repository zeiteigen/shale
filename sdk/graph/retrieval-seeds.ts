import type { Database } from "bun:sqlite";
import { sourceEntityName } from "../../lib/source-identity";
import type { ChunkSearchResult } from "../types";
import type { GraphIngestor } from "../graph";

/** Give each retrieved source a primary seed before adding incidental mentions. */
export function retrievalSeeds(db: Database, graph: GraphIngestor, results: ChunkSearchResult[]): Set<number> {
  const primary = new Set<number>(), additional = new Set<number>();
  const sources = new Set<string>();
  for (const result of results) {
    const identities = db.query<{id:number}, [string,string]>(`
      SELECT id,0 AS priority FROM entities WHERE name=?
      UNION ALL SELECT entity_id AS id,1 AS priority FROM graph_aliases WHERE scope='source-id' AND alias=?
      ORDER BY priority,id LIMIT 21
    `).all(sourceEntityName(result.source_id), result.source_id);
    const mentions = db.query<{id:number}, [number]>(
      "SELECT entity_id AS id FROM chunk_entities WHERE chunk_id=? ORDER BY entity_id LIMIT 21",
    ).all(result.id);
    const candidates = [...identities, ...mentions].map(row => graph.entities.canonical(row.id).id);
    if (!sources.has(result.source_id) && candidates.length) primary.add(candidates[0]);
    sources.add(result.source_id);
    for (const id of candidates) additional.add(id);
  }
  return new Set([...primary, ...additional]);
}
