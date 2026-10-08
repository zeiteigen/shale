import type { Database } from 'bun:sqlite';
import type { GraphIngestor } from '../graph';
import { mutationSchemas } from './schemas';
import { checkVersion, recordVersion } from './version';
import type { ClaimRevision } from './claim-edits';
import { resolveEntityReference } from './entity-reference';
import { activeEvidence } from './active-evidence';

export function reviseEvent(db: Database, graph: GraphIngestor, revise: ClaimRevision, raw:Record<string,unknown>,actor:string,reason:string,refs:Record<string,number>) {
  const a=mutationSchemas.revise_event.parse(raw);checkVersion(db,'event',a.id,a.expectedVersion);
  if(a.name===undefined && a.kind===undefined && a.context===undefined && a.occurredFrom===undefined && a.occurredTo===undefined && a.participants===undefined)
    throw new Error('Provide event fields to revise');
  const old=graph.events.get(a.id);
  const from=a.occurredFrom===undefined ? old.occurredFrom : a.occurredFrom;
  const to=a.occurredTo===undefined ? old.occurredTo : a.occurredTo;
  if(from!==null && to!==null && from>to) throw new Error('Invalid event interval');
  const kind=a.kind ?? old.kind,context=a.context ?? old.context;
  if(a.name!==undefined) graph.entities.rename(a.id,a.name);
  const existence=revise(old.claimId,{value:kind,context},actor,reason,refs).claim;
  const participants=a.participants ?? old.participants.map(p=>({entity:p.entity,role:p.role,position:p.position}));
  const oldClaims=new Map(old.participants.map(p=>[JSON.stringify([p.entity,p.role,p.position]),p.claimId]));
  db.query('DELETE FROM graph_participants WHERE event_id=?').run(a.id);
  db.query('UPDATE graph_events SET kind=?,context=?,occurred_from=?,occurred_to=?,claim_id=? WHERE entity_id=?').run(kind,context,from,to,existence.id,a.id);
  const reused=new Set<string>();
  for(const [index,p] of participants.entries()) {
    const entity=resolveEntityReference(graph,p.entity,refs),position=p.position ?? index;
    const oldId=oldClaims.get(JSON.stringify([entity,p.role,position]));
    const input={subject:a.id,predicate:`ROLE:${p.role}`,object:entity,namespace:old.entity.namespace,context,
      validFrom:from ?? undefined,validTo:to===from ? undefined : to ?? undefined,
      qualifiers:{position},status:existence.status,...('evidence' in p ? {evidence:p.evidence} : oldId ? {} : {evidence:activeEvidence(db,graph,old.claimId)})};
    const claim=oldId ? revise(oldId,{...input,validFrom:from,validTo:to===from ? null : to},actor,reason,refs).claim : graph.claims.add(input);
    if(oldId) reused.add(oldId);
    db.query('INSERT INTO graph_participants VALUES(?,?,?,?,?)').run(a.id,entity,p.role,position,claim.id);
  }
  for(const p of old.participants) if(!reused.has(p.claimId)) graph.lifecycle.review(p.claimId,'retracted',actor,reason);
  return {...graph.events.get(a.id),version:recordVersion(db,'event',a.id)};
}
