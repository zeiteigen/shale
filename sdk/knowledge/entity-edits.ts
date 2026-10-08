import type { Database } from 'bun:sqlite';
import type { GraphIngestor } from '../graph';
import { mutationSchemas, type MutationName } from './schemas';
import { checkVersion, recordVersion } from './version';
import type { ClaimRevision } from './claim-edits';
import { resolveEntityReference } from './entity-reference';

export function executeEntityEdit(db: Database, graph: GraphIngestor, revise: ClaimRevision, name: MutationName, raw: Record<string,unknown>, actor: string, reason: string, refs: Record<string,number>): unknown {
  switch(name) {
    case 'update_entity': {
      const a=mutationSchemas[name].parse(raw); checkVersion(db,'entity',a.id,a.expectedVersion);
      const entity=graph.entities.get(a.id);
      if (a.name === undefined && a.type === undefined) throw new Error('Provide a title or type to update');
      if (a.type !== undefined && a.type!==entity.type) {
        if (entity.canonicalId!==null || db.query('SELECT 1 FROM entities WHERE canonical_id=?').get(a.id))
          throw new Error('Unmerge identities before changing their type');
        if (db.query('SELECT 1 FROM graph_events WHERE entity_id=?').get(a.id) && a.type!=='Event') throw new Error('An event must retain Event type');
        db.query('UPDATE entities SET type=? WHERE id=?').run(a.type,a.id);
        for (const claim of graph.claims.list({entityId:a.id,statuses:['accepted','proposed','disputed'],limit:1000})) graph.relations.validate(claim);
        // list() is bounded; validate all records through paginated access.
        for(let offset=1000;;offset+=1000) {
          const page=graph.claims.list({entityId:a.id,statuses:['accepted','proposed','disputed'],limit:1000,offset});
          for(const claim of page) graph.relations.validate(claim);
          if(page.length<1000) break;
        }
      }
      if(a.name!==undefined) graph.entities.rename(a.id,a.name);
      return {entity:graph.entities.get(a.id),version:recordVersion(db,'entity',a.id)};
    }
    case 'remove_entity_alias': {
      const a=mutationSchemas[name].parse(raw);checkVersion(db,'entity',a.id,a.expectedVersion);graph.entities.get(a.id);
      const removed=db.query('DELETE FROM graph_aliases WHERE entity_id=? AND alias=? AND scope=?').run(a.id,a.name,a.scope);
      if(!removed.changes) throw new Error('Alias does not exist');
      db.query('UPDATE entities SET id=id WHERE id=?').run(a.id); return graph.entities.inspect(a.id);
    }
    case 'append_graph': {
      const a=mutationSchemas[name].parse(raw);
      if(!a.entities.length && !a.claims.length) throw new Error('Provide entities or claims to append');
      const entities=a.entities.map(({ref,...input})=>{
        if(Object.hasOwn(refs,ref)) throw new Error(`Duplicate local reference ${ref}`);
        const entity=graph.entities.create(input);refs[ref]=entity.id;return entity;
      });
      const claims=a.claims.map(input=>graph.claims.add({...input,subject:resolveEntityReference(graph,input.subject,refs),
        object:input.object===undefined ? undefined : resolveEntityReference(graph,input.object,refs)}));
      return {entities,claims,entityRefs:{...refs}};
    }
    case 'split_entity': return splitEntity(db,graph,revise,raw,actor,reason,refs);
    default: throw new Error(`Unsupported graph mutation ${name}`);
  }
}

function splitEntity(db: Database, graph: GraphIngestor, revise: ClaimRevision, raw:Record<string,unknown>,actor:string,reason:string,refs:Record<string,number>) {
  const a=mutationSchemas.split_entity.parse(raw);checkVersion(db,'entity',a.id,a.expectedVersion);
  const original=graph.entities.get(a.id);
  if(original.canonicalId!==null || db.query('SELECT 1 FROM entities WHERE canonical_id=?').get(a.id)) throw new Error('Unmerge identities before splitting');
  if(db.query('SELECT 1 FROM graph_events WHERE entity_id=?').get(a.id)) throw new Error('Use revise_event to correct event participants');
  const assigned=new Set<string>();const results=[];
  for(const {ref,aliasesToMove,claimIds,chunkIds,...input} of a.entities) {
    if(input.stableId===original.stableId) throw new Error('Split nodes must have distinct identities');
    if(input.stableId && db.query('SELECT 1 FROM entities WHERE stable_id=?').get(input.stableId)) throw new Error('Split destination stable ID already exists');
    if(Object.hasOwn(refs,ref)) throw new Error(`Duplicate reference ${ref}`);
    const entity=graph.entities.create(input);
    if(entity.id===a.id) throw new Error('Split must create a distinct node');
    refs[ref]=entity.id;
    for(const alias of aliasesToMove) {
      const key=JSON.stringify(['alias',alias]);if(assigned.has(key)) throw new Error('Alias assigned more than once');assigned.add(key);
      if(!db.query('DELETE FROM graph_aliases WHERE entity_id=? AND alias=? AND scope=?').run(a.id,alias.name,alias.scope).changes) throw new Error('Assigned alias is absent');
      graph.entities.addAlias(entity.id,alias.name,alias.scope);
    }
    const claims=claimIds.map(id=>{
      if(assigned.has(id)) throw new Error('Claim assigned more than once');assigned.add(id);
      const claim=graph.claims.get(id);
      if(claim.subject!==a.id && claim.object!==a.id) throw new Error('Assigned claim does not reference original node');
      return revise(id,{...(claim.subject===a.id ? {subject:entity.id} : {}),...(claim.object===a.id ? {object:entity.id} : {})},actor,reason,refs);
    });
    for(const chunkId of chunkIds) {
      const key=`chunk:${chunkId}`;if(assigned.has(key)) throw new Error('Chunk assigned more than once');assigned.add(key);
      if(!db.query('DELETE FROM chunk_entities WHERE chunk_id=? AND entity_id=?').run(chunkId,a.id).changes) throw new Error('Assigned chunk is not associated with original node');
      db.query('INSERT INTO chunk_entities VALUES(?,?)').run(chunkId,entity.id);
    }
    results.push({entity,claims});
  }
  db.query('UPDATE entities SET id=id WHERE id=?').run(a.id);return {original:graph.entities.inspect(a.id),entities:results,entityRefs:{...refs}};
}
