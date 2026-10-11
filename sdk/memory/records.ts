import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { MEMORY_LIMITS, type PreparedSourceMemory, type SourceObservationMetadata } from '../../lib/memory/types';
import { validateMemory } from '../../lib/memory/prepare';

export function memoryHash(memory: PreparedSourceMemory, fingerprint = ''): string {
  return createHash('sha256').update(JSON.stringify([fingerprint,memory.summary, memory.snippets.map(s => [s.id,s.kind, s.text, s.locator])])).digest('hex');
}

/** Bind current memory to immutable passages already created by revision tracking. */
export function recordMemory(db: Database, sourceId: string, fingerprint: string, memory: PreparedSourceMemory, observed = true, observation:SourceObservationMetadata = {}): void {
  validateMemory(memory);
  const revision = db.query<{id:number},[string]>(`SELECT r.id FROM graph_source_revisions r
    JOIN sources s ON s.id=r.source_id AND s.hash=r.hash WHERE s.id=?`).get(sourceId)!;
  db.query('INSERT INTO source_revision_fingerprints VALUES(?,?) ON CONFLICT(revision_id) DO NOTHING').run(revision.id,fingerprint);
  const summary = db.query<{id:number},[number]>(`SELECT id FROM graph_revision_passages WHERE revision_id=? AND chunk_index=0`).get(revision.id)!;
  db.query("UPDATE graph_revision_passages SET kind='summary' WHERE id=?").run(summary.id);
  db.query(`INSERT INTO source_memories(source_id,version,fingerprint,summary_version,summary_method,coverage,updated_at)
    VALUES(?,1,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET version=version+1,fingerprint=excluded.fingerprint,
    summary_version=excluded.summary_version,summary_method=excluded.summary_method,coverage=excluded.coverage,availability='retained',updated_at=excluded.updated_at`)
    .run(sourceId,fingerprint,summary.id,memory.summaryMethod,JSON.stringify(memory.coverage),Date.now());
  db.query('UPDATE source_snippets SET retired=1 WHERE source_id=?').run(sourceId);
  for (const [i, snippet] of memory.snippets.entries()) {
    const id = snippet.id ?? `snippet:${createHash('sha256').update(JSON.stringify([sourceId,snippet.kind,snippet.text])).digest('hex')}`;
    const passage = db.query<{id:number},[number,number]>('SELECT id FROM graph_revision_passages WHERE revision_id=? AND chunk_index=?').get(revision.id,i+1)!;
    db.query('UPDATE graph_revision_passages SET snippet_id=?,kind=?,locator=? WHERE id=?')
      .run(id,snippet.kind,JSON.stringify(snippet.locator),passage.id);
    db.query(`INSERT INTO source_snippets(id,source_id,current_version,purpose,retired,updated_at) VALUES(?,?,?,?,0,?)
      ON CONFLICT(id) DO UPDATE SET current_version=excluded.current_version,purpose=excluded.purpose,retired=0,updated_at=excluded.updated_at`)
      .run(id,sourceId,passage.id,snippet.purpose,Date.now());
  }
  const source = db.query<{origin:string;updated_at:number},[string]>('SELECT origin,updated_at FROM sources WHERE id=?').get(sourceId)!;
  if (observed) db.query('INSERT INTO source_observations(source_id,fingerprint,captured_at,origin,availability,metadata) VALUES(?,?,?,?,?,?)')
    .run(sourceId,fingerprint,source.updated_at,source.origin,'retained',JSON.stringify({captureOrigin:observation.captureOrigin,quality:observation.quality}));
  db.query(`DELETE FROM source_observations WHERE source_id=? AND id NOT IN
    (SELECT id FROM source_observations WHERE source_id=? ORDER BY id DESC LIMIT ?)`).run(sourceId,sourceId,MEMORY_LIMITS.observations);
}
