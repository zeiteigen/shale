import type { Database } from 'bun:sqlite';
import { MEMORY_LIMITS } from '../../lib/memory/types';

/** Delete uncited history first. Cited passages cannot be silently rewritten or evicted. */
export function compactMemoryHistory(db: Database, sourceId: string, enforce = true): number {
  const current = db.query<{id:number},[string]>(`SELECT r.id FROM graph_source_revisions r JOIN sources s
    ON s.id=r.source_id AND s.hash=r.hash WHERE s.id=?`).get(sourceId)?.id;
  db.query('DELETE FROM source_memory_pins WHERE expires_at<?').run(Date.now());
  const previous = db.query<{id:number},[string,number]>(
    'SELECT id FROM graph_source_revisions WHERE source_id=? AND id<>? ORDER BY id DESC LIMIT 1').get(sourceId,current ?? -1)?.id;
  db.query(`DELETE FROM source_snippets WHERE source_id=? AND retired=1 AND current_version IN (
    SELECT p.id FROM graph_revision_passages p WHERE NOT EXISTS(SELECT 1 FROM graph_evidence e
      WHERE e.revision_id=p.revision_id AND e.chunk_index=p.chunk_index))`).run(sourceId);
  db.query(`DELETE FROM graph_revision_passages WHERE revision_id IN (SELECT id FROM graph_source_revisions WHERE source_id=?)
    AND revision_id<>? AND revision_id<>? AND NOT EXISTS(SELECT 1 FROM graph_evidence e WHERE e.revision_id=graph_revision_passages.revision_id
      AND e.chunk_index=graph_revision_passages.chunk_index)
    AND NOT EXISTS(SELECT 1 FROM source_snippets s WHERE s.current_version=graph_revision_passages.id)
    AND NOT EXISTS(SELECT 1 FROM source_memories m WHERE m.summary_version=graph_revision_passages.id)
    AND NOT EXISTS(SELECT 1 FROM source_memory_pins pin WHERE pin.passage_id=graph_revision_passages.id)`)
    .run(sourceId,current ?? -1,previous ?? -1);
  db.run('DELETE FROM graph_memory_texts WHERE NOT EXISTS(SELECT 1 FROM graph_revision_passages p WHERE p.text_id=graph_memory_texts.id)');
  const size = () => db.query<{characters:number},[string]>(`SELECT coalesce(sum(length(text_content)),0) AS characters FROM graph_memory_texts
    WHERE id IN (SELECT p.text_id FROM graph_revision_passages p JOIN graph_source_revisions r ON r.id=p.revision_id WHERE r.source_id=?)`).get(sourceId)!.characters;
  let count = size();
  if (count > MEMORY_LIMITS.retainedCharacters && previous) {
    db.query(`DELETE FROM graph_revision_passages WHERE revision_id=? AND NOT EXISTS(SELECT 1 FROM graph_evidence e
      WHERE e.revision_id=graph_revision_passages.revision_id AND e.chunk_index=graph_revision_passages.chunk_index)
      AND NOT EXISTS(SELECT 1 FROM source_memory_pins pin WHERE pin.passage_id=graph_revision_passages.id)
      AND NOT EXISTS(SELECT 1 FROM source_snippets s WHERE s.current_version=graph_revision_passages.id)
      AND NOT EXISTS(SELECT 1 FROM source_memories m WHERE m.summary_version=graph_revision_passages.id)`).run(previous);
    db.run('DELETE FROM graph_memory_texts WHERE NOT EXISTS(SELECT 1 FROM graph_revision_passages p WHERE p.text_id=graph_memory_texts.id)');
    count=size();
  }
  if (enforce && count > MEMORY_LIMITS.retainedCharacters) throw new Error('Retained memory budget exhausted by cited versions; explicit evidence compaction is required before expanding this source');
  return count;
}
