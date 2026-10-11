import type { Database } from 'bun:sqlite';
import type { PreparedSourceMemory } from '../../lib/memory/types';
import { memoryChunks } from '../../lib/memory/prepare';

/** Current chunks are a compatibility search projection, never an original-source archive. */
export function projectMemory(db:Database,sourceId:string,memory:PreparedSourceMemory):number[] {
  const ids:number[]=[];
  const prior=new Map(db.query<{snippet_id:string;id:number},[string]>(`SELECT s.id AS snippet_id,c.id FROM source_snippets s
    JOIN graph_revision_passages p ON p.id=s.current_version JOIN chunks c ON c.source_id=s.source_id AND c.chunk_index=p.chunk_index
    WHERE s.source_id=? AND s.retired=0`).all(sourceId).map(row=>[row.snippet_id,row.id]));
  const summaryId=db.query<{id:number},[string]>('SELECT id FROM chunks WHERE source_id=? AND chunk_index=0').get(sourceId)?.id;
  for (const chunk of memoryChunks(memory)) {
    const id=chunk.chunk_index===0 ? summaryId : prior.get(memory.snippets[chunk.chunk_index-1]!.id ?? '');
    if (id!==undefined) {
      db.query('UPDATE chunks SET chunk_index=?,text_content=?,chunk_type=? WHERE id=?').run(chunk.chunk_index,chunk.text_content,chunk.chunk_type,id);
      ids.push(id);
    } else ids.push(db.query<{id:number},[string,number,string,string]>(
      'INSERT INTO chunks(source_id,chunk_index,chunk_type,text_content) VALUES(?,?,?,?) RETURNING id').get(sourceId,chunk.chunk_index,chunk.chunk_type,chunk.text_content)!.id);
  }
  db.query(`DELETE FROM chunks WHERE source_id=? AND id NOT IN (${ids.map(()=>'?').join(',')})`).run(sourceId,...ids);
  db.query(`INSERT OR IGNORE INTO graph_revision_chunks(revision_id,chunk_index,chunk_type,text_content)
    SELECT r.id,c.chunk_index,c.chunk_type,c.text_content FROM chunks c JOIN sources s ON s.id=c.source_id
    JOIN graph_source_revisions r ON r.source_id=s.id AND r.hash=s.hash WHERE s.id=?`).run(sourceId);
  return ids;
}
