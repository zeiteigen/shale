import type { Database } from "bun:sqlite";
import { classifySource } from "./heuristics";

export const REVISION_CONTENT_HASH_SQL = "json_array(r.hash,r.uri,r.title)";

/** Classify retained historical text independently of the source's current content. */
export function classifyRevisions(db: Database, deadline: number, batch: number, sourceIds?: string[]) {
  let classified = 0;
  const passages = db.query<{ text_content: string }, [number]>(
    "SELECT text_content FROM graph_revision_chunks WHERE revision_id=? ORDER BY chunk_index");
  for (;;) {
    if (!sourceIds && Date.now() > deadline) return { classified, pending: true };
    const filter = sourceIds ? ` AND r.source_id IN (SELECT value FROM json_each(?))` : "";
    const rows = db.query<{ id: number; title: string; uri: string; content_hash: string }, (string | number)[]>(
      `SELECT r.id,r.title,r.uri,${REVISION_CONTENT_HASH_SQL} AS content_hash FROM graph_source_revisions r
       LEFT JOIN graph_access_revision_labels l ON l.revision_id=r.id
       WHERE (l.revision_id IS NULL OR l.content_hash<>(${REVISION_CONTENT_HASH_SQL}))${filter} LIMIT ?`,
    ).all(...(sourceIds ? [JSON.stringify(sourceIds)] : []), batch);
    if (!rows.length) return { classified, pending: false };
    db.transaction(() => {
      for (const row of rows) {
        const text = passages.all(row.id).map(p => p.text_content).join("\n");
        const verdict = classifySource({ ...row, origin: "", type: "", text });
        db.query(`INSERT INTO graph_access_revision_labels(revision_id,tier,hard,content_hash,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(revision_id) DO UPDATE SET tier=excluded.tier,hard=excluded.hard,
          content_hash=excluded.content_hash,updated_at=excluded.updated_at`)
          .run(row.id, verdict.tier, verdict.hard ? 1 : 0, row.content_hash, Date.now());
      }
    })();
    classified += rows.length;
  }
}
