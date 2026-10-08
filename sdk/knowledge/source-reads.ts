import type { Database } from 'bun:sqlite';
import { readSchemas } from './schemas';
import { recordVersion } from './version';
import { SourceRecords } from './source-records';
import type { Chunk,Source } from './source-records';

export class KnowledgeSourceReads {
  private records:SourceRecords;
  constructor(private db:Database) { this.records=new SourceRecords(db); }
  read(name:string,args:Record<string,unknown>):unknown {
    switch(name) {
      case 'list_sources': {
        const a=readSchemas.list_sources.parse(args);
        const cte=`WITH catalog AS (
          SELECT s.id,s.type,s.uri,s.origin,s.created_at,s.title,s.updated_at,s.hash,coalesce(m.metadata,'{}') AS metadata,'live' AS status,
            NULL AS removed_at,NULL AS removal_actor,NULL AS removal_reason FROM sources s
          LEFT JOIN graph_source_metadata m ON m.source_id=s.id
          UNION ALL SELECT json_extract(snapshot,'$.source.id'),json_extract(snapshot,'$.source.type'),
          json_extract(snapshot,'$.source.uri'),json_extract(snapshot,'$.source.origin'),json_extract(snapshot,'$.source.created_at'),
          json_extract(snapshot,'$.source.title'),json_extract(snapshot,'$.source.updated_at'),json_extract(snapshot,'$.source.hash'),
          coalesce(json_extract(snapshot,'$.metadata'),'{}'),'removed',removed_at,actor,reason FROM graph_source_archives
          WHERE NOT EXISTS(SELECT 1 FROM sources s WHERE s.id=graph_source_archives.source_id))
          `;
        const conditions:string[]=[], params:(string|number)[]=[];
        if(a.status!=='all') { conditions.push('status=?'); params.push(a.status); }
        if(a.title!==undefined) { conditions.push('instr(lower(title),lower(?))>0'); params.push(a.title); }
        if(a.uri!==undefined) { conditions.push('instr(uri,?)>0'); params.push(a.uri); }
        if(a.origin!==undefined) { conditions.push('origin=?'); params.push(a.origin); }
        if(a.type!==undefined) { conditions.push('type=?'); params.push(a.type); }
        if(a.namespace!==undefined) { conditions.push("json_extract(metadata,'$.namespace')=?"); params.push(a.namespace); }
        const where=conditions.length ? ` WHERE ${conditions.join(' AND ')}`:'';
        const total=this.db.query<{total:number},(string|number)[]>(cte+'SELECT count(*) AS total FROM catalog'+where).get(...params)!.total;
        const rows=this.db.query<Record<string,unknown>,(string|number)[]>(cte+'SELECT * FROM catalog'+where+' ORDER BY updated_at DESC,id LIMIT ? OFFSET ?').all(...params,a.limit,a.offset);
        return {sources:rows.map(row=>({...row,metadata:JSON.parse(row.metadata as string),version:recordVersion(this.db,'source',row.id as string)})),total,limit:a.limit,offset:a.offset};
      }
      case 'inspect_source': {
        const a=readSchemas.inspect_source.parse(args), live=this.db.query<Source,[string]>('SELECT * FROM sources WHERE id=?').get(a.sourceId);
        const archived=live ? undefined : this.records.archive(a.sourceId), source=live ?? archived!.source;
        const evidence=this.evidenceRows(source.id,undefined,201), entities=this.relatedEntities(source.id,201);
        const affected=this.db.query<{claim_id:string},[string]>(`SELECT DISTINCT e.claim_id FROM graph_evidence e JOIN graph_source_revisions r
          ON r.id=e.revision_id WHERE r.source_id=? ORDER BY e.claim_id LIMIT 201`).all(source.id);
        return {source:{...source,version:recordVersion(this.db,'source',source.id)},status:live ? 'live':'removed',
          removal:live ? undefined : this.db.query('SELECT actor,reason,removed_at FROM graph_source_archives WHERE source_id=?').get(source.id),
          metadata:live ? this.records.getMetadata(source.id):archived!.metadata,
          chunkCount:live ? this.db.query<{count:number},[string]>('SELECT count(*) AS count FROM chunks WHERE source_id=?').get(source.id)!.count:archived!.chunks.length,
          entities:entities.slice(0,200),evidence:evidence.slice(0,200),affectedClaimIds:affected.slice(0,200).map(r=>r.claim_id),
          truncated:{entities:entities.length>200,evidence:evidence.length>200,affectedClaims:affected.length>200},
          counts:{entities:this.relatedEntityCount(source.id),evidence:this.db.query<{count:number},[string]>(`SELECT count(*) AS count FROM graph_evidence e
            JOIN graph_source_revisions r ON r.id=e.revision_id WHERE r.source_id=?`).get(source.id)!.count,
            affectedClaims:this.db.query<{count:number},[string]>(`SELECT count(DISTINCT e.claim_id) AS count FROM graph_evidence e
            JOIN graph_source_revisions r ON r.id=e.revision_id WHERE r.source_id=?`).get(source.id)!.count},
          revisions:this.db.query('SELECT * FROM graph_source_revisions WHERE source_id=? ORDER BY id DESC LIMIT 200').all(source.id),
          exclusions:this.db.query('SELECT * FROM graph_source_exclusions WHERE source_id=?').all(source.id)};
      }
      case 'list_chunks': {
        const a=readSchemas.list_chunks.parse(args); if(!a.archived) this.records.source(a.sourceId);
        const archive=a.archived ? this.records.archive(a.sourceId):undefined;
        const chunks=archive ? archive.chunks.slice(a.offset,a.offset+a.limit):this.db.query<Chunk,[string,number,number]>(
          'SELECT * FROM chunks WHERE source_id=? ORDER BY chunk_index,id LIMIT ? OFFSET ?').all(a.sourceId,a.limit,a.offset);
        const total=archive ? archive.chunks.length:this.db.query<{count:number},[string]>('SELECT count(*) AS count FROM chunks WHERE source_id=?').get(a.sourceId)!.count;
        return {sourceId:a.sourceId,sourceVersion:recordVersion(this.db,'source',a.sourceId),archived:a.archived,
          chunks:chunks.map(c=>({...c,version:recordVersion(this.db,'chunk',c.id),entityIds:archive ? archive.links.filter(l=>l.chunk_id===c.id).map(l=>l.entity_id):
            this.db.query<{entity_id:number},[number]>('SELECT entity_id FROM chunk_entities WHERE chunk_id=? ORDER BY entity_id').all(c.id).map(r=>r.entity_id),
            evidence:this.evidenceRows(a.sourceId,c.chunk_index,201).slice(0,200)})),total,limit:a.limit,offset:a.offset};
      }
      default: throw new Error(`Unsupported source read: ${name}`);
    }
  }

  private evidenceRows(sourceId:string,chunkIndex:number|undefined,limit:number) {
    return this.db.query<Record<string,unknown>,(string|number)[]>(`SELECT e.*,r.source_id,r.hash,
      EXISTS(SELECT 1 FROM graph_evidence_history h WHERE h.evidence_id=e.id) AS withdrawn,
      NOT EXISTS(SELECT 1 FROM sources s WHERE s.id=r.source_id AND s.hash=r.hash) AS stale
      FROM graph_evidence e JOIN graph_source_revisions r ON r.id=e.revision_id WHERE r.source_id=?
      ${chunkIndex===undefined ? '':'AND e.chunk_index=?'} ORDER BY e.created_at DESC,e.id LIMIT ?`)
      .all(sourceId,...(chunkIndex===undefined ? []:[chunkIndex]),limit)
      .map(row=>({...row,version:recordVersion(this.db,'evidence',row.id as string)}));
  }
  private relatedEntityQuery() {
    return `WITH related AS (
      SELECT e.id FROM entities e LEFT JOIN graph_aliases a ON a.entity_id=e.id WHERE e.name='source:'||? OR (a.scope='source-id' AND a.alias=?)
      UNION SELECT ce.entity_id FROM chunk_entities ce JOIN chunks c ON c.id=ce.chunk_id WHERE c.source_id=?
      UNION SELECT CAST(json_extract(l.value,'$.entity_id') AS INTEGER) FROM graph_source_archives a,json_each(a.snapshot,'$.links') l WHERE a.source_id=?
      UNION SELECT c.subject_id FROM graph_claims c JOIN graph_evidence e ON e.claim_id=c.id JOIN graph_source_revisions r ON r.id=e.revision_id WHERE r.source_id=?
      UNION SELECT c.object_id FROM graph_claims c JOIN graph_evidence e ON e.claim_id=c.id JOIN graph_source_revisions r ON r.id=e.revision_id WHERE r.source_id=? AND c.object_id IS NOT NULL)`;
  }
  private relatedEntities(id:string,limit:number) {
    return this.db.query<{id:number;title:string;type:string;namespace:string},[string,string,string,string,string,string,number]>(this.relatedEntityQuery()+
      ' SELECT e.id,coalesce(e.display_name,e.name) AS title,e.type,e.namespace FROM entities e JOIN related r ON r.id=e.id ORDER BY e.id LIMIT ?')
      .all(id,id,id,id,id,id,limit).map(row=>({...row,version:recordVersion(this.db,'entity',row.id)}));
  }
  private relatedEntityCount(id:string) {
    return this.db.query<{count:number},[string,string,string,string,string,string]>(this.relatedEntityQuery()+
      ' SELECT count(*) AS count FROM entities e JOIN related r ON r.id=e.id').get(id,id,id,id,id,id)!.count;
  }
}
