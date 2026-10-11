import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { MEMORY_LIMITS } from './types';

/** Explicitly reground small quoted spans; unavailable old text never masquerades as retained evidence. */
export function migrateHistoricalEvidence(db:Database,sourceId:string,budget=12000) {
  const passages=db.query<{id:number;revision_id:number;chunk_index:number;chunk_type:string;text_content:string},[string]>(
    `SELECT p.*,t.text_content FROM graph_revision_passages p JOIN graph_memory_texts t ON t.id=p.text_id
      JOIN graph_source_revisions r ON r.id=p.revision_id WHERE r.source_id=? ORDER BY r.id DESC,p.chunk_index`).all(sourceId);
  let retained=0,discarded=0,regrounded=0;
  const type=db.query<{type:string},[string]>('SELECT type FROM sources WHERE id=?').get(sourceId)?.type;
  const operational=['browser_activity','browser_history','browser_bookmark','web_session'].includes(type??'') || sourceId.startsWith('session:');
  for(const passage of passages) {
    if(db.query(`SELECT 1 FROM source_memories WHERE summary_version=? UNION ALL SELECT 1 FROM source_snippets WHERE current_version=?
      UNION ALL SELECT 1 FROM source_memory_pins WHERE passage_id=? LIMIT 1`).get(passage.id,passage.id,passage.id)) continue;
    const evidence=db.query<{id:string;claim_id:string;quote:string|null;locator:string;stance:string;withdrawn:number},[number,number]>(
      `SELECT id,claim_id,quote,locator,stance,EXISTS(SELECT 1 FROM graph_evidence_history h WHERE h.evidence_id=e.id) AS withdrawn
        FROM graph_evidence e WHERE revision_id=? AND chunk_index=? ORDER BY id`).all(passage.revision_id,passage.chunk_index);
    const quotes=[...new Set(evidence.map(e=>e.quote).filter((q):q is string=>!!q))];
    let structured=false;
    if(operational&&!quotes.length) {try{structured=typeof JSON.parse(passage.text_content)==='object';}catch{}}
    if(structured) {
      db.query('DELETE FROM graph_revision_passages WHERE id=?').run(passage.id);
      for(const ev of evidence) db.query('UPDATE graph_evidence SET chunk_index=NULL,locator=? WHERE id=?')
        .run(JSON.stringify({migration:'structured-observation',originalLocator:JSON.parse(ev.locator),originalChunkIndex:passage.chunk_index}),ev.id);
      regrounded+=evidence.length;continue;
    }
    let excerpt=''; let start=0;
    if(quotes.length) {
      const spans=quotes.map(q=>({start:passage.text_content.indexOf(q),end:passage.text_content.indexOf(q)+q.length}));
      start=Math.min(...spans.map(s=>s.start));
      const end=Math.max(...spans.map(s=>s.end));
      if(start>=0 && end-start<=MEMORY_LIMITS.snippet) excerpt=passage.text_content.slice(start,end);
    } else if(evidence.length && passage.text_content.length<=MEMORY_LIMITS.snippet) excerpt=passage.text_content;
    if(excerpt && retained+excerpt.length<=budget) {
      const textId=db.query<{id:number},[string]>(`INSERT INTO graph_memory_texts(text_content) VALUES(?)
        ON CONFLICT(text_content) DO UPDATE SET text_content=excluded.text_content RETURNING id`).get(excerpt)!.id;
      db.query('UPDATE graph_revision_passages SET text_id=?,kind=?,locator=? WHERE id=?')
        .run(textId,passage.chunk_type==='synthetic'?'derived':'excerpt',JSON.stringify({originalChunkIndex:passage.chunk_index,start,end:start+excerpt.length,migrated:true}),passage.id);
      for(const ev of evidence) {
        const old=JSON.parse(ev.locator),quoteStart=ev.quote?excerpt.indexOf(ev.quote):undefined;
        const locator={...old,originalSpan:old.start===undefined?undefined:{start:old.start,end:old.end},
          ...(quoteStart===undefined?{start:undefined,end:undefined}:{start:quoteStart,end:quoteStart+ev.quote!.length}),migration:'retained-excerpt'};
        db.query('UPDATE graph_evidence SET locator=? WHERE id=?').run(JSON.stringify(locator),ev.id);
      }
      retained+=excerpt.length;regrounded+=evidence.length;
    } else {
      db.query('INSERT INTO source_memory_discarded VALUES(?,?,?,?,?) ON CONFLICT(revision_id,chunk_index) DO NOTHING')
        .run(passage.revision_id,passage.chunk_index,createHash('sha256').update(passage.text_content).digest('hex'),passage.text_content.length,
          excerpt?'historical evidence budget':'original body discarded');
      db.query('DELETE FROM graph_revision_passages WHERE id=?').run(passage.id);
      for(const ev of evidence) {
        db.query('UPDATE graph_evidence SET quote=NULL,locator=? WHERE id=?').run(JSON.stringify({availability:'discarded',
          originalLocator:JSON.parse(ev.locator),quoteFingerprint:ev.quote?createHash('sha256').update(ev.quote).digest('hex'):undefined}),ev.id);
        if(ev.stance==='supports'&&!ev.withdrawn)
          db.query("UPDATE graph_claims SET status='stale' WHERE id=? AND status IN ('accepted','proposed','disputed')").run(ev.claim_id);
      }
      discarded+=evidence.length;
    }
  }
  return {retainedCharacters:retained,regroundedEvidence:regrounded,discardedEvidence:discarded};
}
