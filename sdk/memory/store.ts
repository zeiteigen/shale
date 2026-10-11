import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { randomUUIDv7 } from 'bun';
import { memoryChunks, validateMemory } from '../../lib/memory/prepare';
import type { PreparedSourceMemory, PreparedSnippet, SourceMemoryRecord } from '../../lib/memory/types';
import { recordMemory, memoryHash } from './records';
import { compactMemoryHistory } from './retention';
import { projectMemory } from './projection';
import { searchMemory } from './search';

export interface MemoryEdit {
  sourceId:string; expectedVersion:number; actor:string; reason:string; requestId?:string;
  summary?:string; add?:PreparedSnippet[];
  revise?:Array<{id:string;text:string;kind?:'excerpt'|'derived';locator?:PreparedSnippet['locator'];purpose?:string}>;
  retire?:string[];
}

/** The single read/edit contract used by agents and later autonomous consolidation. */
export class SourceMemoryStore {
  constructor(private db:Database) {}

  search(options: { query:string; limit?:number; offset?:number; origin?:string; type?:string; sourceId?:string }) {
    return searchMemory(this.db, options);
  }

  get(sourceId:string): SourceMemoryRecord {
    const source = this.db.query<{id:string;uri:string;title:string;type:string;origin:string;updated_at:number},[string]>(
      'SELECT id,uri,title,type,origin,updated_at FROM sources WHERE id=?').get(sourceId);
    const memory = this.db.query<{version:number;fingerprint:string;summary_version:number;summary_method:PreparedSourceMemory['summaryMethod'];coverage:string;availability:string;updated_at:number},[string]>(
      'SELECT * FROM source_memories WHERE source_id=?').get(sourceId);
    if (!source || !memory) throw new Error('Source has no retained memory; migrate or refresh it first');
    const summary = this.db.query<{text:string},[number]>('SELECT t.text_content AS text FROM graph_revision_passages p JOIN graph_memory_texts t ON t.id=p.text_id WHERE p.id=?').get(memory.summary_version)!;
    const snippets = this.db.query<{id:string;versionId:number;text:string;kind:PreparedSnippet['kind'];locator:string;purpose:string},[string]>(
      `SELECT s.id,p.id AS versionId,t.text_content AS text,p.kind,p.locator,s.purpose FROM source_snippets s
      JOIN graph_revision_passages p ON p.id=s.current_version JOIN graph_memory_texts t ON t.id=p.text_id
      WHERE s.source_id=? AND s.retired=0 ORDER BY p.chunk_index`).all(sourceId).map(s=>({...s,locator:JSON.parse(s.locator)}));
    const observation=this.db.query<{captured_at:number;metadata:string},[string]>(
      'SELECT captured_at,metadata FROM source_observations WHERE source_id=? ORDER BY captured_at DESC,id DESC LIMIT 1').get(sourceId);
    return { source,version:memory.version,summary:{text:summary.text,versionId:memory.summary_version,method:memory.summary_method},snippets,
      coverage:JSON.parse(memory.coverage),freshness:{fingerprint:memory.fingerprint,lastObservedAt:observation?.captured_at ?? null,
        observation:observation?JSON.parse(observation.metadata):null},
      availability:memory.availability,completeOriginal:false };
  }

  snippet(versionId:number) {
    const row = this.db.query<{id:number;snippet_id:string|null;kind:string;locator:string;text:string;revision_id:number;chunk_index:number},[number]>(
      `SELECT p.*,t.text_content AS text FROM graph_revision_passages p JOIN graph_memory_texts t ON t.id=p.text_id WHERE p.id=?`).get(versionId);
    if (!row) throw new Error('Snippet version is unavailable');
    return {...row,locator:JSON.parse(row.locator),completeOriginal:false};
  }

  edit(input:MemoryEdit) {
    if (!input.actor.trim() || !input.reason.trim()) throw new Error('Actor and reason are required');
    const signature = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.db.transaction(()=>{
      if (input.requestId) {
        const prior = this.db.query<{fingerprint:string;result:string},[string]>('SELECT fingerprint,result FROM source_memory_changes WHERE request_id=?').get(input.requestId);
        if (prior) { if (prior.fingerprint !== signature) throw new Error('Request ID reused for a different edit'); return JSON.parse(prior.result); }
      }
      const current = this.get(input.sourceId);
      if (current.version !== input.expectedVersion) throw new Error(`Memory version conflict: expected ${input.expectedVersion}, current ${current.version}`);
      const snippets:PreparedSnippet[] = current.snippets.map(({id,text,kind,locator,purpose})=>({id,text,kind,locator,purpose}));
      for (const patch of input.revise ?? []) {
        const index = snippets.findIndex(s=>s.id===patch.id);
        if (index < 0) throw new Error('Unknown active snippet');
        snippets[index] = {...snippets[index]!,...patch,purpose:patch.purpose ?? 'agent refinement'};
      }
      for (const id of input.retire ?? []) if (!snippets.some(s=>s.id===id)) throw new Error('Unknown active snippet');
      const next = snippets.filter(s=>!input.retire?.includes(s.id!));
      for (const snippet of input.add ?? []) next.push({...snippet,id:randomUUIDv7()});
      // Agents can quote retained text; novel text is explicitly derived until source refresh verifies it.
      for (const snippet of next) if (snippet.kind === 'excerpt') {
        const observed=current.snippets.find(old=>old.kind==='excerpt' && old.text.includes(snippet.text));
        if(!observed) throw new Error('New excerpts must match retained observed text; refresh the original source or mark this snippet derived');
        const offset=observed.text.indexOf(snippet.text),start=typeof observed.locator.start==='number'?observed.locator.start+offset:undefined;
        // Verified source coordinates come from the observed excerpt, never an agent assertion.
        snippet.locator={...observed.locator,start,end:start===undefined?undefined:start+snippet.text.length};
      }
      const memory:PreparedSourceMemory={summary:input.summary ?? current.summary.text,
        summaryMethod:input.summary === undefined ? current.summary.method : 'agent',snippets:next,coverage:current.coverage};
      validateMemory(memory);
      const hash=memoryHash(memory,current.freshness.fingerprint);
      this.db.query('INSERT INTO source_memory_write_intents VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET hash=excluded.hash').run(input.sourceId,hash);
      this.db.query('UPDATE sources SET hash=?,updated_at=? WHERE id=?').run(hash,Date.now(),input.sourceId);
      projectMemory(this.db,input.sourceId,memory);
      recordMemory(this.db,input.sourceId,current.freshness.fingerprint,memory,false);
      this.db.query('DELETE FROM source_memory_write_intents WHERE source_id=?').run(input.sourceId);
      compactMemoryHistory(this.db,input.sourceId);
      this.db.query(`INSERT OR IGNORE INTO chunk_entities(chunk_id,entity_id) SELECT c.id,e.entity_id
        FROM chunks c JOIN source_entities e ON e.source_id=c.source_id WHERE c.source_id=?`).run(input.sourceId);
      const result={sourceId:input.sourceId,version:current.version+1,snippetIds:next.map(s=>s.id)};
      this.db.query(`INSERT INTO source_memory_changes(source_id,version,actor,reason,request_id,fingerprint,result,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(input.sourceId,result.version,input.actor,input.reason,input.requestId ?? null,signature,JSON.stringify(result),Date.now());
      this.db.query('DELETE FROM source_memory_changes WHERE source_id=? AND request_id IS NULL AND id NOT IN (SELECT id FROM source_memory_changes WHERE source_id=? ORDER BY id DESC LIMIT 32)').run(input.sourceId,input.sourceId);
      return result;
    })();
  }
}
