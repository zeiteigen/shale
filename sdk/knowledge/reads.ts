import type { Database } from 'bun:sqlite';
import type { GraphIngestor } from '../graph';
import type { ChunkSearcher } from '../search';
import { KnowledgeGraphEdits } from './graph-edits';
import { readSchemas } from './schemas';
import { recordVersion } from './version';

export class KnowledgeReads {
  constructor(private db:Database,private graph:GraphIngestor,private search:ChunkSearcher) {}

  async read(name:string,raw:Record<string,unknown>):Promise<unknown> {
    switch(name) {
      case 'list_entities': {
        const a=readSchemas.list_entities.parse(raw),where:string[]=['NOT EXISTS(SELECT 1 FROM graph_entity_retirements r WHERE r.entity_id=e.id)'],params:(string|number)[]=[];
        if(a.name!==undefined) {where.push(`(instr(lower(coalesce(e.display_name,e.name)),lower(?))>0 OR EXISTS(
          SELECT 1 FROM graph_aliases a WHERE a.entity_id=e.id AND instr(lower(a.alias),lower(?))>0))`);params.push(a.name,a.name);}
        if(a.type!==undefined) {where.push('e.type=?');params.push(a.type);}
        if(a.namespace!==undefined) {where.push('e.namespace=?');params.push(a.namespace);}
        const clause=where.length ? ` WHERE ${where.join(' AND ')}` : '';
        const total=this.db.query<{n:number},(string|number)[]>(`SELECT count(*) AS n FROM entities e${clause}`).get(...params)!.n;
        const rows=this.db.query<{id:number},(string|number)[]>(`SELECT e.id FROM entities e${clause} ORDER BY e.id LIMIT ? OFFSET ?`).all(...params,a.limit,a.offset);
        return {entities:rows.map(r=>({...this.graph.entities.get(r.id),version:recordVersion(this.db,'entity',r.id)})),total,limit:a.limit,offset:a.offset};
      }
      case 'list_connections': {
        const a=readSchemas.list_connections.parse(raw),id=this.graph.entities.canonical(new KnowledgeGraphEdits(this.db,this.graph).resolve(a.entity)).id;
        const members=this.db.query<{id:number},[number]>(`WITH RECURSIVE members(id) AS (
          SELECT ? UNION SELECT e.id FROM entities e JOIN members m ON e.canonical_id=m.id) SELECT id FROM members LIMIT 501`).all(id).map(r=>r.id);
        if(members.length>500) throw new Error('Merged identity exceeds the 500-member connection query limit');
        const placeholders=members.map(()=>'?').join(','),where=['object_id IS NOT NULL'],params:(string|number)[]=[];
        if(a.direction==='both') {where.push(`(subject_id IN (${placeholders}) OR object_id IN (${placeholders}))`);params.push(...members,...members);}
        else {where.push(`${a.direction==='out' ? 'subject_id' : 'object_id'} IN (${placeholders})`);params.push(...members);}
        const statuses=a.statuses ?? ['accepted','proposed','disputed'];
        if(!statuses.length || (a.predicates && !a.predicates.length)) return {entityId:id,connections:[],hasMore:false};
        where.push(`status IN (${statuses.map(()=>'?').join(',')})`);params.push(...statuses);
        if(a.predicates) {where.push(`predicate IN (${a.predicates.map(()=>'?').join(',')})`);params.push(...a.predicates);}
        if(a.context!==undefined) {where.push('context=?');params.push(a.context);}
        const rows=this.db.query<{id:string},(string|number)[]>(`SELECT id FROM graph_claims WHERE ${where.join(' AND ')} ORDER BY recorded_at,id LIMIT ? OFFSET ?`)
          .all(...params,a.limit+1,a.offset);
        const claims=rows.map(r=>this.graph.claims.get(r.id));
        return {entityId:id,connections:claims.slice(0,a.limit).map(c=>({...c,version:recordVersion(this.db,'claim',c.id),
          subjectEntity:this.graph.entities.canonical(c.subject),objectEntity:this.graph.entities.canonical(c.object!),
          evidence:this.graph.evidence.list(c.id)})),hasMore:claims.length>a.limit};
      }
      case 'get_source_revision': {
        const a=readSchemas.get_source_revision.parse(raw);return this.graph.evidence.revision(a.revisionId);
      }
      case 'find_duplicate_entities': return this.duplicates(raw);
      case 'find_connection_candidates': return this.connections(raw);
      default: throw new Error(`Unsupported knowledge read ${name}`);
    }
  }

  private duplicates(raw:Record<string,unknown>) {
    const a=readSchemas.find_duplicate_entities.parse(raw),resolver=new KnowledgeGraphEdits(this.db,this.graph);
    const focus=a.entity===undefined ? undefined : this.graph.entities.canonical(resolver.resolve(a.entity));
    const rows=this.db.query<{id:number},[string|null,string|null]>(`SELECT id FROM entities WHERE canonical_id IS NULL
      AND (? IS NULL OR namespace=?) ORDER BY id LIMIT 501`).all(a.namespace ?? null,a.namespace ?? null);
    const entities=rows.slice(0,500).map(r=>this.graph.entities.get(r.id));
    if(focus && !entities.some(e=>e.id===focus.id)) entities.unshift(focus);
    const names=new Map<number,Map<string,string>>();
    for(const e of entities) {
      const labels=new Map([[`name:${e.name.trim().toLowerCase()}`,'matching title']]);
      for(const alias of this.graph.entities.inspect(e.id).aliases) labels.set(
        alias.scope.startsWith('external:') ? `${alias.scope}:${alias.alias}` : `name:${alias.alias.trim().toLowerCase()}`,
        alias.scope.startsWith('external:') ? 'matching external identifier' : 'matching title or alias');
      names.set(e.id,labels);
    }
    const candidates:Array<{from:number;into:number;signals:string[];sameType:boolean;score:number}>=[];
    for(let i=0;i<entities.length;i++) for(let j=i+1;j<entities.length;j++) {
      const left=entities[i]!,right=entities[j]!;
      if(focus && left.id!==focus.id && right.id!==focus.id) continue;
      const signals=[...new Set([...names.get(left.id)!].filter(([key])=>names.get(right.id)!.has(key)).map(([,why])=>why))];
      if(!signals.length) continue;
      const sameType=left.type===right.type;
      candidates.push({from:left.id,into:right.id,signals,sameType,score:signals.includes('matching external identifier') ? 1 : sameType ? 0.8 : 0.4});
    }
    candidates.sort((a,b)=>b.score-a.score || a.from-b.from || a.into-b.into);
    return {candidates:candidates.slice(0,a.limit).map(c=>({...c,fromEntity:this.graph.entities.get(c.from),intoEntity:this.graph.entities.get(c.into)})),
      truncated:rows.length>500 || candidates.length>a.limit,scannedEntities:entities.length,requiresReview:true};
  }

  private async connections(raw:Record<string,unknown>) {
    const a=readSchemas.find_connection_candidates.parse(raw),resolver=new KnowledgeGraphEdits(this.db,this.graph);
    const entity=this.graph.entities.canonical(resolver.resolve(a.entity));
    const neighborhood=this.graph.query.traverse({start:entity.id,direction:'both',maxDepth:2,maxNodes:200,maxClaims:1000,statuses:['accepted']});
    const direct=new Set(neighborhood.paths.filter(p=>p.depth===1).map(p=>p.entityId));
    const candidates=new Map<number,{entityId:number;signals:Set<string>;claimIds:Set<string>;chunkIds:Set<number>;score:number}>();
    const add=(id:number,signal:string,score:number,claimIds:string[]=[],chunkIds:number[]=[])=>{
      id=this.graph.entities.canonical(id).id;
      if(id===entity.id || direct.has(id)) return;
      const target=this.graph.entities.get(id);if(a.namespace && target.namespace!==a.namespace) return;
      const c=candidates.get(id) ?? {entityId:id,signals:new Set<string>(),claimIds:new Set<string>(),chunkIds:new Set<number>(),score:0};
      c.signals.add(signal);c.score=Math.max(c.score,score);claimIds.forEach(x=>c.claimIds.add(x));chunkIds.forEach(x=>c.chunkIds.add(x));candidates.set(id,c);
    };
    for(const path of neighborhood.paths) if(path.depth===2) add(path.entityId,'shared graph neighbor',0.7,path.claimIds);
    const cooccurrences=this.db.query<{entity_id:number;chunk_id:number},[number]>(`SELECT DISTINCT other.entity_id,other.chunk_id
      FROM chunk_entities seed JOIN chunk_entities other ON other.chunk_id=seed.chunk_id
      WHERE seed.entity_id=? AND other.entity_id<>seed.entity_id LIMIT 501`).all(entity.id);
    for(const row of cooccurrences.slice(0,500)) add(row.entity_id,'appears in the same source chunk',0.8,[],[row.chunk_id]);
    const passages=await this.search.bm25({query:entity.name,limit:20});
    for(const passage of passages) {
      const linked=this.db.query<{entity_id:number},[number]>('SELECT entity_id FROM chunk_entities WHERE chunk_id=? LIMIT 100').all(passage.id);
      for(const row of linked) add(row.entity_id,'title appears in source text',0.5,[],[passage.id]);
    }
    const sorted=[...candidates.values()].sort((a,b)=>b.score-a.score || a.entityId-b.entityId);
    return {entity,candidates:sorted.slice(0,a.limit).map(c=>({entity:this.graph.entities.get(c.entityId),score:c.score,signals:[...c.signals],
      claimIds:[...c.claimIds],chunkIds:[...c.chunkIds],supportingClaims:[...c.claimIds].map(id=>this.graph.inspect(id))})),
      truncated:neighborhood.truncated || cooccurrences.length>500 || sorted.length>a.limit,requiresReview:true};
  }
}
