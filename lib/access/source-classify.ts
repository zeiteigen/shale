import type { Database } from "bun:sqlite";
import { classifySource } from "./heuristics";
import { setLabel } from "./schema";
import { LIVE_SOURCE_CONTENT_HASH_SQL, sourceContentHash, type SourceContent } from "./source-hash";

const SOURCE_TEXT_LIMIT = 200_000;

/** Classify live sources and removed snapshots, including metadata-only edits. */
export function classifySources(db: Database, deadline: number, batch: number, sourceIds?: string[]) {
  let classified = 0;
  const textSQL = `
    SELECT text_content,chunk_index FROM chunks WHERE source_id=?
    UNION ALL SELECT json_extract(c.value,'$.text_content'),json_extract(c.value,'$.chunk_index')
      FROM graph_source_archives a,json_each(a.snapshot,'$.chunks') c
      WHERE a.source_id=? AND NOT EXISTS(SELECT 1 FROM sources WHERE id=a.source_id)
    ORDER BY chunk_index`;
  const snapshot = (key: keyof SourceContent) => `coalesce(json_extract(a.snapshot,'$.source.${key}'),'')`;
  for (;;) {
    if (!sourceIds && Date.now() > deadline) return { classified, pending: true };
    const filter = sourceIds ? " AND s.id IN (SELECT value FROM json_each(?))" : "";
    const rows = db.query<SourceContent & { id: string }, (string | number)[]>(`
      WITH catalog AS (
        SELECT id,hash,title,uri,origin,type FROM sources
        UNION ALL SELECT a.source_id,${["hash", "title", "uri", "origin", "type"].map(key => snapshot(key as keyof SourceContent)).join(",")}
          FROM graph_source_archives a WHERE NOT EXISTS(SELECT 1 FROM sources WHERE id=a.source_id)
      )
      SELECT s.* FROM catalog s LEFT JOIN graph_access_labels l ON l.kind='source' AND l.record_id=s.id AND l.origin='heuristic'
      WHERE (l.record_id IS NULL OR l.content_hash<>${LIVE_SOURCE_CONTENT_HASH_SQL})${filter} LIMIT ?`
    ).all(...(sourceIds ? [JSON.stringify(sourceIds)] : []), batch);
    if (!rows.length) return { classified, pending: false };
    db.transaction(() => {
      for (const source of rows) {
        let text = "";
        // A truncated cached iterator retains its read snapshot until reset/finalized.
        const textRows=db.prepare<{text_content:string},[string,string]>(textSQL);
        try {
          for (const chunk of textRows.iterate(source.id, source.id)) {
            text += `${chunk.text_content}\n`;
            if (text.length >= SOURCE_TEXT_LIMIT) break;
          }
        } finally {textRows.finalize();}
        const verdict = classifySource({ ...source, text });
        setLabel(db, "source", source.id, "heuristic", verdict.tier,
          { hard: verdict.hard, reason: verdict.reason, contentHash: sourceContentHash(source) });
      }
    }).immediate();
    classified += rows.length;
  }
}
