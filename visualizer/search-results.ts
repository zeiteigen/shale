import type { Database } from "bun:sqlite";
import type { ChunkSearchResult } from "../sdk";
import { sourceEntityName, graphIdentityFromSourceUri } from "../lib/source-identity";
import { sourceMap, type GraphSource } from "./source-map";

/** Search and map navigation resolve the same persistent connector identities. */
export function enrichResults(results: ChunkSearchResult[], db: Database) {
  if (!results.length) return [];
  const ids = [...new Set(results.map(result => result.source_id))];
  const sources = db.query<GraphSource, string[]>(
    `SELECT id,uri,title FROM sources WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids);
  const entities = new Map<string, number>();
  for (const [entity, source] of sourceMap(db, sources))
    if (!entities.has(source.id)) entities.set(source.id, entity);
  const legacy = db.query<{id: number}, [string, string, string, string]>(`
    SELECT id FROM entities WHERE name=? OR name=?
      OR (lower(name)=lower(?) AND (SELECT count(*) FROM sources WHERE lower(title)=lower(?))=1)
    ORDER BY id LIMIT 1`);
  return results.map(result => ({ ...result,
    entity_id: entities.get(result.source_id) ?? (result.source_title ? legacy.get(
      sourceEntityName(result.source_id), graphIdentityFromSourceUri(result.source_uri ?? ""),
      result.source_title, result.source_title)?.id : undefined),
    preview: result.preview || result.text_content.slice(0, 280),
  }));
}
