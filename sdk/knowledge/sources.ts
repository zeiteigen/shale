import { randomUUIDv7 } from 'bun';
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { GraphIngestor } from '../graph';
import type { EmbeddingClient } from '../embed';
import { getIndexDimension, vectorBuffer } from '../../lib/embedding-index';
import { assertEmbeddingProfile, embeddingProfile, readEmbeddingProfile } from '../../lib/embedding-profile';
import { graphIdentityFromSourceUri, sourceEntityName } from '../../lib/source-identity';
import { mutationSchemas, type MutationName } from './schemas';
import { checkVersion, recordVersion } from './version';
import { SourceRecords, type Source, type Chunk, type Snapshot } from './source-records';
import { KnowledgeSourceReads } from './source-reads';

const staleNotice = 'Source revision changes conservatively mark supported claims stale; review them explicitly.';
const split = (text:string,size:number) => Array.from({length:Math.ceil(text.length/size)},(_,i)=>text.slice(i*size,(i+1)*size));
const hash = (uri:string,chunks:Pick<Chunk,'chunk_index'|'chunk_type'|'text_content'>[]) =>
  createHash('sha256').update(JSON.stringify([uri,chunks.map(c=>[c.chunk_index,c.chunk_type,c.text_content])])).digest('hex');

/** Source edits run in the caller's transaction; embedding work happens beforehand. */
export class KnowledgeSources {
  private records:SourceRecords;
  constructor(private db:Database,private graph:GraphIngestor,private namespace:string) { this.records=new SourceRecords(db); }

  async prepare(name:MutationName,args:Record<string,unknown>,embedder:EmbeddingClient):Promise<number[][]|undefined> {
    const texts=this.texts(name,args);
    return texts?.length ? embedder.embedBatch(texts) : texts ? [] : undefined;
  }

  texts(name:MutationName,args:Record<string,unknown>):string[]|undefined {
    let texts:string[]|undefined;
    switch (name) {
      case 'add_source': { const a=mutationSchemas.add_source.parse(args); texts=split(a.text,a.chunkSize); break; }
      case 'add_chunk': { const a=mutationSchemas.add_chunk.parse(args); texts=[a.text]; break; }
      case 'revise_chunk': { const a=mutationSchemas.revise_chunk.parse(args); if(a.text!==undefined) texts=[a.text]; break; }
      case 'restore_source': { const a=mutationSchemas.restore_source.parse(args); texts=this.records.archive(a.sourceId).chunks.map(c=>c.text_content); break; }
      case 'update_source': mutationSchemas.update_source.parse(args); break;
      case 'remove_source': mutationSchemas.remove_source.parse(args); break;
      case 'remove_chunk': mutationSchemas.remove_chunk.parse(args); break;
      default: throw new Error(`Unsupported source mutation: ${name}`);
    }
    return texts;
  }

  execute(name:MutationName,args:Record<string,unknown>,vectors:number[][]|undefined,actor:string,reason:string):unknown {
    switch(name) {
      case 'add_source': {
        const a=mutationSchemas.add_source.parse(args), id=a.id ?? randomUUIDv7(), now=Date.now();
        if(this.db.query('SELECT 1 FROM sources WHERE id=?').get(id) || this.db.query('SELECT 1 FROM graph_source_archives WHERE source_id=?').get(id)) throw new Error(`Source identity already exists: ${id}`);
        this.checkIdentity(id,a.uri);
        const chunks=split(a.text,a.chunkSize).map((text_content,chunk_index)=>({text_content,chunk_index,chunk_type:'verbatim'}));
        const buffers=this.buffers(vectors,chunks.length);
        this.db.query('INSERT INTO sources(id,type,uri,origin,created_at,title,updated_at,hash) VALUES(?,?,?,?,?,?,?,?)')
          .run(id,a.type,a.uri,a.origin,now,a.title,now,hash(a.uri,chunks));
        this.metadata(id,{...a.metadata,namespace:a.namespace ?? this.namespace});
        const chunkIds=chunks.map((c,i)=>this.insertChunk(id,c,buffers[i]!));
        this.snapshotRevision(id);
        const entity=this.graph.entities.create({stableId:`knowledge-source:${id}`,namespace:a.namespace ?? this.namespace,
          name:a.title,type:'Source',aliases:[{name:id,scope:'source-id'},{name:a.uri,scope:'source-uri'}]});
        this.addBackingClaim(id,entity.id,'TITLE',a.title); this.addBackingClaim(id,entity.id,'SOURCE_URI',a.uri);
        for(const chunk of this.records.chunks(id)) this.addBackingClaim(id,entity.id,'HAS_CONTENT',chunk.text_content,chunk);
        return {sourceId:id,entityId:entity.id,chunkIds,version:recordVersion(this.db,'source',id),namespace:a.namespace ?? this.namespace};
      }
      case 'update_source': {
        const a=mutationSchemas.update_source.parse(args), source=this.records.source(a.sourceId);
        if(a.title===undefined && a.uri===undefined && a.metadata===undefined) throw new Error('Source update requires title, URI, or metadata');
        checkVersion(this.db,'source',a.sourceId,a.expectedVersion);
        this.checkIdentity(source.id,a.uri ?? source.uri);
        if(a.title!==undefined) this.renameSourceEntities(source,a.title);
        this.db.query('UPDATE sources SET title=?,uri=?,hash=?,updated_at=? WHERE id=?').run(a.title ?? source.title,a.uri ?? source.uri,
          a.uri!==undefined ? hash(a.uri,this.records.chunks(source.id)) : source.hash,Date.now(),source.id);
        if(a.metadata!==undefined) this.metadata(source.id,{...a.metadata,namespace:this.records.getMetadata(source.id).namespace ?? this.namespace});
        this.snapshotRevision(source.id);
        this.replaceBackingClaims(source,a.title,a.uri,actor,reason);
        return {sourceId:source.id,version:recordVersion(this.db,'source',source.id),notice:staleNotice};
      }
      case 'remove_source': {
        const a=mutationSchemas.remove_source.parse(args), source=this.records.source(a.sourceId);
        checkVersion(this.db,'source',source.id,a.expectedVersion);
        const snapshot:Snapshot={source,chunks:this.records.chunks(source.id),links:this.db.query<{chunk_id:number;entity_id:number},[string]>(
          'SELECT ce.* FROM chunk_entities ce JOIN chunks c ON c.id=ce.chunk_id WHERE c.source_id=?').all(source.id),metadata:this.records.getMetadata(source.id)};
        this.db.query(`INSERT INTO graph_source_archives(source_id,snapshot,actor,reason,removed_at) VALUES(?,?,?,?,?)
          ON CONFLICT(source_id) DO UPDATE SET snapshot=excluded.snapshot,actor=excluded.actor,reason=excluded.reason,removed_at=excluded.removed_at`)
          .run(source.id,JSON.stringify(snapshot),actor,reason,Date.now());
        if(a.blockReingestion) for(const identity of this.identities(source.id,source.uri)) this.db.query(
          'INSERT OR IGNORE INTO graph_source_exclusions(identity,source_id,actor,reason,created_at) VALUES(?,?,?,?,?)').run(identity,source.id,actor,reason,Date.now());
        this.db.query('DELETE FROM sources WHERE id=?').run(source.id);
        this.db.query('DELETE FROM graph_source_metadata WHERE source_id=?').run(source.id);
        return {sourceId:source.id,removed:true,blocked:a.blockReingestion,version:recordVersion(this.db,'source',source.id),notice:staleNotice};
      }
      case 'restore_source': {
        const a=mutationSchemas.restore_source.parse(args), archived=this.records.archive(a.sourceId), source=archived.source;
        checkVersion(this.db,'source',source.id,a.expectedVersion);
        if(this.db.query('SELECT 1 FROM sources WHERE id=?').get(source.id)) throw new Error('Source is already live');
        if(a.unblockReingestion) this.db.query('DELETE FROM graph_source_exclusions WHERE source_id=?').run(source.id);
        this.checkIdentity(source.id,source.uri);
        const buffers=this.buffers(vectors,archived.chunks.length);
        this.db.query('INSERT INTO sources(id,type,uri,origin,created_at,title,updated_at,hash) VALUES(?,?,?,?,?,?,?,?)')
          .run(source.id,source.type,source.uri,source.origin,source.created_at,source.title,Date.now(),source.hash);
        this.metadata(source.id,archived.metadata);
        const ids=new Map<number,number>();
        for(const [i,c] of archived.chunks.entries()) {
          // Preserve IDs when free, but never replace another source's chunks.
          const available=!this.db.query('SELECT 1 FROM chunks WHERE id=?').get(c.id);
          const id=this.insertChunk(source.id,c,buffers[i]!,available ? c.id : undefined); ids.set(c.id,id);
        }
        for(const link of archived.links) if(this.db.query('SELECT 1 FROM entities WHERE id=?').get(link.entity_id))
          this.db.query('INSERT OR IGNORE INTO chunk_entities(chunk_id,entity_id) VALUES(?,?)').run(ids.get(link.chunk_id)!,link.entity_id);
        this.snapshotRevision(source.id);
        this.db.query('DELETE FROM graph_source_archives WHERE source_id=?').run(source.id);
        return {sourceId:source.id,restored:true,chunkIds:[...ids.values()],chunkIdMap:Object.fromEntries(ids),version:recordVersion(this.db,'source',source.id),notice:'Restoring a source does not automatically accept stale claims.'};
      }
      case 'add_chunk': {
        const a=mutationSchemas.add_chunk.parse(args); const source=this.records.source(a.sourceId); checkVersion(this.db,'source',a.sourceId,a.expectedVersion);
        const chunk_index=this.db.query<{max:number|null},[string,string]>(`SELECT max(chunk_index) AS max FROM (
          SELECT chunk_index FROM chunks WHERE source_id=? UNION ALL SELECT c.chunk_index FROM graph_revision_chunks c
          JOIN graph_source_revisions r ON r.id=c.revision_id WHERE r.source_id=?)`).get(a.sourceId,a.sourceId)!.max ?? -1;
        const nextIndex=chunk_index+1;
        const next={chunk_index:nextIndex,text_content:a.text,chunk_type:a.chunkType}, buffer=this.buffers(vectors,1)[0]!;
        // Set the new revision first so the chunk INSERT trigger cannot alter the old snapshot.
        this.db.query('UPDATE sources SET hash=?,updated_at=? WHERE id=?').run(hash(source.uri,[...this.records.chunks(a.sourceId),next]),Date.now(),a.sourceId);
        const chunkId=this.insertChunk(a.sourceId,next,buffer);
        this.snapshotRevision(a.sourceId); this.assign(a.sourceId,chunkId,a.entityIds,a.claimIds,actor,reason);
        return {sourceId:a.sourceId,chunkId,version:recordVersion(this.db,'chunk',chunkId),sourceVersion:recordVersion(this.db,'source',a.sourceId),notice:staleNotice};
      }
      case 'revise_chunk': {
        const a=mutationSchemas.revise_chunk.parse(args), chunk=this.records.chunk(a.sourceId,a.chunkId);
        if(a.text===undefined && a.chunkType===undefined && a.entityIds===undefined && a.claimIds===undefined) throw new Error('Chunk revision requires text, type, entities, or claims');
        checkVersion(this.db,'chunk',chunk.id,a.expectedVersion); checkVersion(this.db,'source',a.sourceId,a.expectedSourceVersion);
        if(a.text!==undefined || a.chunkType!==undefined) {
          const buffer=a.text!==undefined ? this.buffers(vectors,1)[0]! : undefined;
          this.db.query('UPDATE chunks SET text_content=?,chunk_type=? WHERE id=?').run(a.text ?? chunk.text_content,a.chunkType ?? chunk.chunk_type,chunk.id);
          if(buffer) { this.db.query('DELETE FROM vector_index WHERE rowid=?').run(chunk.id); this.db.query('INSERT INTO vector_index(rowid,embedding) VALUES(?,?)').run(chunk.id,buffer); }
          this.refresh(a.sourceId);
        }
        this.assign(a.sourceId,chunk.id,a.entityIds,a.claimIds,actor,reason);
        return {sourceId:a.sourceId,chunkId:chunk.id,version:recordVersion(this.db,'chunk',chunk.id),sourceVersion:recordVersion(this.db,'source',a.sourceId),notice:staleNotice};
      }
      case 'remove_chunk': {
        const a=mutationSchemas.remove_chunk.parse(args), chunk=this.records.chunk(a.sourceId,a.chunkId);
        checkVersion(this.db,'chunk',chunk.id,a.expectedVersion); checkVersion(this.db,'source',a.sourceId,a.expectedSourceVersion);
        this.db.query('DELETE FROM chunks WHERE id=?').run(chunk.id); this.refresh(a.sourceId);
        return {sourceId:a.sourceId,chunkId:chunk.id,removed:true,version:recordVersion(this.db,'chunk',chunk.id),sourceVersion:recordVersion(this.db,'source',a.sourceId),notice:staleNotice};
      }
      default: throw new Error(`Unsupported source mutation: ${name}`);
    }
  }

  read(name:string,args:Record<string,unknown>):unknown {
    return new KnowledgeSourceReads(this.db).read(name,args);
  }

  private sourceEntities(id:string) {
    return this.db.query<{id:number},[string,string]>(`SELECT DISTINCT e.id FROM entities e LEFT JOIN graph_aliases a ON a.entity_id=e.id
      WHERE e.name=? OR (a.scope='source-id' AND a.alias=?)`).all(sourceEntityName(id),id);
  }
  private addBackingClaim(sourceId:string,entityId:number,predicate:string,value:string,chunk?:Chunk) {
    const source=this.records.source(sourceId), entity=this.graph.entities.get(entityId);
    const revision=this.db.query<{id:number},[string,string]>('SELECT id FROM graph_source_revisions WHERE source_id=? AND hash=?').get(sourceId,source.hash)!;
    return this.graph.claims.add({namespace:entity.namespace,subject:entityId,predicate,value,context:source.uri,status:'accepted',method:'manual',
      evidence:[{revisionId:revision.id,...(chunk ? {chunkIndex:chunk.chunk_index,quote:chunk.text_content}:{})}]}).id;
  }
  private replaceBackingClaims(source:Source,title:string|undefined,uri:string|undefined,actor:string,reason:string) {
    for(const entity of this.sourceEntities(source.id)) {
      for(const [predicate,value,oldValue] of [['TITLE',title,source.title],['SOURCE_URI',uri,source.uri]] as const) {
        if(value===undefined || value===oldValue) continue;
        const prior=this.db.query<{id:string},[number,string,string,string]>(`SELECT c.id FROM graph_claims c WHERE c.subject_id=? AND c.predicate=?
          AND c.value_json=? AND c.status NOT IN ('rejected','retracted','superseded') AND EXISTS(SELECT 1 FROM graph_evidence e
          JOIN graph_source_revisions r ON r.id=e.revision_id WHERE e.claim_id=c.id AND r.source_id=?)`).all(entity.id,predicate,JSON.stringify(oldValue),source.id);
        for(const old of prior) this.graph.lifecycle.review(old.id,'superseded',actor,reason);
        const replacement=this.addBackingClaim(source.id,entity.id,predicate,value);
        for(const old of prior) this.db.query("INSERT OR IGNORE INTO graph_claim_links(source_id,target_id,relation) VALUES(?,?,'supersedes')").run(replacement,old.id);
        if(predicate==='SOURCE_URI') { this.graph.entities.addAlias(entity.id,oldValue,'source-uri'); this.graph.entities.addAlias(entity.id,value,'source-uri'); }
      }
    }
  }

  private identities(id:string,uri:string):string[] { return [...new Set([id,`id:${id}`,uri,graphIdentityFromSourceUri(uri)])]; }
  private checkIdentity(id:string,uri:string) {
    if(this.db.query('SELECT 1 FROM sources WHERE uri=? AND id<>?').get(uri,id)) throw new Error(`Source URI already belongs to another source: ${uri}`);
    for(const identity of this.identities(id,uri)) if(this.db.query('SELECT 1 FROM graph_source_exclusions WHERE identity=?').get(identity))
      throw new Error(`Source is excluded from ingestion: ${identity}; explicitly unblock it when restoring`);
  }
  private metadata(id:string,value:Record<string,unknown>) {
    this.db.query('INSERT INTO graph_source_metadata(source_id,metadata) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET metadata=excluded.metadata').run(id,JSON.stringify(value));
  }
  private buffers(vectors:number[][]|undefined,count:number):Uint8Array[] {
    if(!vectors || vectors.length!==count) throw new Error(`Expected ${count} prepared embeddings`);
    const recorded=readEmbeddingProfile(this.db), dimension=getIndexDimension(this.db);
    const tracked=recorded!==null || vectors.some(v=>embeddingProfile(v)!==undefined);
    return vectors.map(vector=>{
      const profile=embeddingProfile(vector);
      if(profile) assertEmbeddingProfile(this.db,profile,true);
      else if(tracked) throw new Error('Prepared embedding lacks the indexed embedding profile');
      return vectorBuffer(vector,dimension);
    });
  }
  private insertChunk(sourceId:string,c:Pick<Chunk,'chunk_index'|'text_content'|'chunk_type'>,buffer:Uint8Array,id?:number):number {
    const chunk=this.db.query<{id:number},[number|null,string,number,string,string]>(
      'INSERT INTO chunks(id,source_id,chunk_index,chunk_type,text_content) VALUES(?,?,?,?,?) RETURNING id').get(id ?? null,sourceId,c.chunk_index,c.chunk_type,c.text_content)!;
    this.db.query('INSERT INTO vector_index(rowid,embedding) VALUES(?,?)').run(chunk.id,buffer); return chunk.id;
  }
  private refresh(id:string) {
    const source=this.records.source(id);
    this.db.query('UPDATE sources SET hash=?,updated_at=? WHERE id=?').run(hash(source.uri,this.records.chunks(id)),Date.now(),id);
    this.snapshotRevision(id);
  }
  private snapshotRevision(id:string) {
    this.db.query(`INSERT OR IGNORE INTO graph_source_revisions(source_id,hash,uri,title,captured_at)
      SELECT id,hash,uri,title,updated_at FROM sources WHERE id=?`).run(id);
    this.db.query(`INSERT OR IGNORE INTO graph_revision_chunks(revision_id,chunk_index,chunk_type,text_content)
      SELECT r.id,c.chunk_index,c.chunk_type,c.text_content FROM chunks c JOIN sources s ON s.id=c.source_id
      JOIN graph_source_revisions r ON r.source_id=s.id AND r.hash=s.hash WHERE s.id=?`).run(id);
  }
  private renameSourceEntities(source:Source,title:string) {
    const rows=this.db.query<{id:number},[string,string]>(`SELECT DISTINCT e.id FROM entities e LEFT JOIN graph_aliases a ON a.entity_id=e.id
      WHERE e.name=? OR (a.scope='source-id' AND a.alias=?)`).all(sourceEntityName(source.id),source.id);
    for(const row of rows) {
      this.db.query('INSERT OR IGNORE INTO graph_aliases(entity_id,alias,scope) VALUES(?,?,?)').run(row.id,source.title,'');
      this.db.query('INSERT OR IGNORE INTO graph_aliases(entity_id,alias,scope) VALUES(?,?,?)').run(row.id,title,'');
      this.db.query('UPDATE entities SET display_name=? WHERE id=?').run(title,row.id);
    }
  }
  private assign(sourceId:string,chunkId:number,entityIds:number[]|undefined,claimIds:string[]|undefined,actor:string,reason:string) {
    const chunk=this.records.chunk(sourceId,chunkId);
    if(entityIds!==undefined) {
      for(const id of entityIds) this.graph.entities.get(id);
      this.db.query('DELETE FROM chunk_entities WHERE chunk_id=?').run(chunkId);
      for(const id of entityIds) this.db.query('INSERT OR IGNORE INTO chunk_entities(chunk_id,entity_id) VALUES(?,?)').run(chunkId,id);
    }
    if(claimIds!==undefined) {
      for(const id of claimIds) if(!this.db.query('SELECT 1 FROM graph_claims WHERE id=?').get(id)) throw new Error(`Unknown claim: ${id}`);
      const revision=this.db.query<{id:number},[string]>(`SELECT r.id FROM graph_source_revisions r JOIN sources s ON s.id=r.source_id AND s.hash=r.hash WHERE s.id=?`).get(sourceId)!;
      const prior=this.db.query<{id:string;claim_id:string},[string,number]>(`SELECT e.id,e.claim_id FROM graph_evidence e
        JOIN graph_source_revisions r ON r.id=e.revision_id WHERE r.source_id=? AND e.chunk_index=? AND e.stance='supports'
        AND NOT EXISTS(SELECT 1 FROM graph_evidence_history h WHERE h.evidence_id=e.id)`).all(sourceId,chunk.chunk_index);
      for(const old of prior) {
        this.db.query('INSERT INTO graph_evidence_history(evidence_id,replacement_id,actor,reason,withdrawn_at) VALUES(?,NULL,?,?,?)').run(old.id,actor,reason,Date.now());
        this.db.query("UPDATE graph_claims SET status='stale' WHERE id=? AND status IN ('accepted','proposed','disputed')").run(old.claim_id);
      }
      for(const claimId of new Set(claimIds)) this.graph.evidence.add(claimId,{revisionId:revision.id,chunkIndex:chunk.chunk_index,quote:chunk.text_content,method:'manual'});
    }
    if(entityIds!==undefined || claimIds!==undefined) {
      this.db.query('UPDATE chunks SET chunk_type=chunk_type WHERE id=?').run(chunkId);
      this.db.query('UPDATE sources SET updated_at=? WHERE id=?').run(Date.now(),sourceId);
    }
  }
}
