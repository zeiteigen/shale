import { randomUUIDv7 } from 'bun';
import type { Database } from 'bun:sqlite';
import type { GraphIngestor } from '../graph';
import type { ChunkSearcher } from '../search';
import { ensureKnowledgeEditingSchema } from '../../lib/knowledge/schema';
import { mutationSchemas, changeInput, type MutationName, type MutationArgs, readSchemas } from './schemas';
import { KnowledgeGraphEdits } from './graph-edits';
import { KnowledgeSources } from './sources';
import { KnowledgeReads } from './reads';
import { recordVersion } from './version';
import { projectConnections } from './projection';
import { fingerprint, replay, saveChange, type ChangeContext } from './audit';
import { compactAudit } from '../../lib/memory/audit';

type Operation={type:MutationName;args:Record<string,unknown>};
const sourceOperations=new Set(['add_source','update_source','remove_source','restore_source','add_chunk','revise_chunk','remove_chunk']);
class PreviewRollback extends Error {constructor(readonly result:unknown){super('Preview rollback');}}

/** Scope check for restricted access profiles (lib/access/write-guard.ts). */
export interface KnowledgeGuard {
  /** Verify and normalize the records an operation references, before any write. */
  prepare(name:string,args:Record<string,unknown>):Record<string,unknown>;
  /** Inside the transaction, once the journal is active. */
  begin():void;
  /** Inside the transaction after the work; throwing rolls the change back. */
  check():void;
  /** Remove references the caller may not see from a receipt. */
  redact<T>(result:T):T;
}

/** One mutation engine backs individual tools, ordered batches, and previews. */
export class KnowledgeEditor {
  private graphEdits:KnowledgeGraphEdits;
  private sources:KnowledgeSources;
  private reads:KnowledgeReads;
  private guard?:KnowledgeGuard;
  constructor(private db:Database,private graph:GraphIngestor,search:ChunkSearcher,namespace:string) {
    ensureKnowledgeEditingSchema(db);
    this.graphEdits=new KnowledgeGraphEdits(db,graph);this.sources=new KnowledgeSources(db,graph,namespace);this.reads=new KnowledgeReads(db,graph,search);
  }

  /** Route every audited write through an access-scope check. */
  setGuard(guard:KnowledgeGuard|undefined) {this.guard=guard;}

  mutate<N extends MutationName>(name:N,args:MutationArgs<N>,context:ChangeContext) {
    return this.apply({...context,operations:[{type:name,args}]});
  }

  async read(name:keyof typeof readSchemas,args:Record<string,unknown>) {
    const parsed=readSchemas[name].parse(args);
    return ['list_sources','inspect_source','list_chunks'].includes(name) ? this.sources.read(name,parsed) : this.reads.read(name,parsed);
  }

  history(changeId?:string) {
    if(!changeId) return this.db.query('SELECT id,actor,reason,created_at FROM graph_changes ORDER BY created_at DESC,id LIMIT 100').all();
    const row=this.db.query<{operations:string;result:string},[string]>('SELECT * FROM graph_changes WHERE id=?').get(changeId);
    return row ? {...row,operations:JSON.parse(row.operations),result:JSON.parse(row.result)} : null;
  }

  apply(input:unknown) {return this.run(input,false);}
  preview(input:unknown) {return this.run(input,true);}

  private async run(input:unknown,preview:boolean):Promise<unknown> {
    const parsed=changeInput.parse(input),operations=parsed.operations as unknown as Operation[];
    if(JSON.stringify(parsed).length>5_000_000) throw new Error('Change batch exceeds the 5 MB payload limit');
    const signature=fingerprint(parsed);
    if(!preview) {const previous=replay(this.db,parsed.requestId,signature);if(previous!==undefined) return this.redact(previous);}
    return this.execute(parsed,operations,preview);
  }

  private execute(parsed:ReturnType<typeof changeInput.parse>,operations:Operation[],
    preview:boolean):unknown {
    const signature=fingerprint(parsed);
    try {
      return this.db.transaction(()=>{
        if(!preview) {const previous=replay(this.db,parsed.requestId,signature);if(previous!==undefined) return this.redact(previous);}
        const changeId=randomUUIDv7(),refs:Record<string,number>={};
        const details=[];
        // A TEMP journal records exactly the records changed, including trigger invalidation.
        this.db.run('DELETE FROM knowledge_edit_journal');
        this.db.run('UPDATE knowledge_edit_session SET active=1 WHERE id=1');
        this.guard?.begin();
        for(const operation of operations) {
          let args=mutationSchemas[operation.type].parse(operation.args) as Record<string,unknown>;
          if(this.guard) args=this.guard.prepare(operation.type,args);
          const before=this.snapshot(args);
          const result=sourceOperations.has(operation.type) ? this.sources.execute(operation.type,args,parsed.actor,parsed.reason) :
            this.graphEdits.execute(operation.type,args,parsed.actor,parsed.reason,refs);
          details.push({type:operation.type,args:compactAudit(args),before:compactAudit(before),result,after:compactAudit(this.snapshot(args))});
        }
        const changed=this.db.query<{kind:string;record_id:string},[]>('SELECT DISTINCT kind,record_id FROM knowledge_edit_journal').all();
        const claimIds=changed.filter(r=>r.kind==='claim').map(r=>r.record_id);
        projectConnections(this.db,claimIds);
        this.guard?.check();
        const invalidatedClaims=claimIds.map(id=>this.graph.claims.get(id)).filter(c=>['stale','proposed','disputed'].includes(c.status));
        const result={changeId,preview,operations:details,entityRefs:refs,
          affectedRecords:changed.map(r=>({...r,version:recordVersion(this.db,r.kind,r.record_id)})),
          requiresReview:invalidatedClaims.map(c=>c.id),affectedClaimCount:claimIds.length};
        const receipt=this.redact(result);
        if(preview) throw new PreviewRollback(receipt);
        saveChange(this.db,parsed,parsed,result,changeId);
        this.db.run('DELETE FROM knowledge_edit_journal');
        this.db.run('UPDATE knowledge_edit_session SET active=0 WHERE id=1');
        return receipt;
      })();
    } catch(error) {if(error instanceof PreviewRollback) return error.result;throw error;}
  }

  /** Existing mutation APIs retain their response shape while gaining audit/retry support. */
  record<T>(action:string,input:unknown,context:ChangeContext,work:(input:unknown)=>T):T {
    if(!context.actor.trim() || !context.reason.trim()) throw new Error('Actor and reason are required');
    const payload={action,input,actor:context.actor,reason:context.reason},signature=fingerprint(payload);
    const previous=replay(this.db,context.requestId,signature);if(previous!==undefined) return this.redact(previous as T);
    // Names resolve among visible entities only; the work receives the normalized input.
    const prepared=this.guard && typeof input==='object' && input!==null ? this.guard.prepare(action,input as Record<string,unknown>) : input;
    return this.db.transaction(()=>{
      const existing=replay(this.db,context.requestId,signature);if(existing!==undefined) return this.redact(existing as T);
      this.db.run('DELETE FROM knowledge_edit_journal');
      this.db.run('UPDATE knowledge_edit_session SET active=1 WHERE id=1');
      this.guard?.begin();
      const before=this.snapshot(typeof input==='object' && input!==null ? input as Record<string,unknown> : {});
      const result=work(prepared);
      if(result instanceof Promise) throw new Error('Audited writes must be synchronous; prepare model work first');
      const affected=this.db.query<{kind:string;record_id:string},[]>('SELECT DISTINCT kind,record_id FROM knowledge_edit_journal').all();
      const claims=affected.filter(r=>r.kind==='claim').map(r=>r.record_id);
      projectConnections(this.db,claims);
      this.guard?.check();
      const changeId=randomUUIDv7();
      const response=result!==null && typeof result==='object' && !Array.isArray(result) ? {...result,auditChangeId:changeId,
        affectedRecords:affected.map(r=>({...r,version:recordVersion(this.db,r.kind,r.record_id)})),
        requiresReview:claims.filter(id=>['stale','proposed','disputed'].includes(this.graph.claims.get(id).status))} : result;
      saveChange(this.db,payload,context,response,changeId);
      // before/after are retained separately in the operation payload for historical correction inspection.
      this.db.query('UPDATE graph_changes SET operations=? WHERE id=?').run(JSON.stringify(compactAudit({...payload,before,after:this.snapshot(typeof input==='object' && input!==null ? input as Record<string,unknown> : {})})),changeId);
      const receipt=this.redact(response as T);
      this.db.run('DELETE FROM knowledge_edit_journal');
      this.db.run('UPDATE knowledge_edit_session SET active=0 WHERE id=1');
      return receipt;
    })();
  }

  private redact<T>(result:T):T {return this.guard ? this.guard.redact(result) : result;}

  private snapshot(args:Record<string,unknown>) {
    const records:Record<string,unknown>={};
    const entityIds=[args.id,args.from,args.into].filter(x=>typeof x==='number') as number[];
    for(const id of entityIds) if(this.db.query('SELECT 1 FROM entities WHERE id=?').get(id)) records[`entity:${id}`]=this.graph.entities.inspect(id);
    const claimIds=[args.claimId,args.from,args.to].filter(x=>typeof x==='string') as string[];
    if(Array.isArray(args.claims)) for(const c of args.claims) if(c && typeof c==='object' && 'claimId' in c && typeof c.claimId==='string') claimIds.push(c.claimId);
    for(const id of claimIds) if(this.db.query('SELECT 1 FROM graph_claims WHERE id=?').get(id)) records[`claim:${id}`]=this.graph.inspect(id);
    if(typeof args.sourceId==='string') {
      const source=this.db.query('SELECT * FROM sources WHERE id=?').get(args.sourceId);
      records[`source:${args.sourceId}`]=source ?? this.db.query('SELECT * FROM graph_source_archives WHERE source_id=?').get(args.sourceId);
      records.chunks=this.db.query('SELECT id,source_id,chunk_index,chunk_type FROM chunks WHERE source_id=? ORDER BY chunk_index,id').all(args.sourceId);
      records.metadata=this.db.query('SELECT * FROM graph_source_metadata WHERE source_id=?').get(args.sourceId);
      records.chunkLinks=this.db.query('SELECT ce.* FROM chunk_entities ce JOIN chunks c ON c.id=ce.chunk_id WHERE c.source_id=?').all(args.sourceId);
    }
    if(typeof args.evidenceId==='string') records.evidence=this.db.query('SELECT * FROM graph_evidence WHERE id=?').get(args.evidenceId);
    if(typeof args.id==='number') records.event=this.db.query('SELECT * FROM graph_events WHERE entity_id=?').get(args.id);
    return records;
  }

}
