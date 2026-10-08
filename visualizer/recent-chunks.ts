import type { Database } from 'bun:sqlite';

/** One scan for all source previews; fetch text only after ranking chunk IDs in reading order. */
export function recentChunksBySource(db: Database, limit = 5) {
  const rows = db.query<{ id: number; source_id: string; chunk_index: number; text_content: string }, [number]>(`
    WITH ranked AS (
      SELECT id, source_id,
        row_number() OVER (
          PARTITION BY source_id
          ORDER BY
            CASE WHEN text_content LIKE '{\\n  "url":%' OR text_content LIKE '{"url":%' THEN 1 ELSE 0 END ASC,
            chunk_index ASC,
            id ASC
        ) AS position
      FROM chunks
    ) SELECT c.id, c.source_id, c.chunk_index, c.text_content FROM ranked r JOIN chunks c ON c.id = r.id
      WHERE r.position <= ? ORDER BY c.source_id, c.chunk_index, c.id
  `).all(limit);
  const sources = new Map<string, typeof rows>();
  for (const row of rows) {
    let chunks = sources.get(row.source_id);
    if (!chunks) sources.set(row.source_id, (chunks = []));
    chunks.push(row);
  }
  return sources;
}
