import type { Database } from 'bun:sqlite';
import type { GraphIngestor } from '../graph';
import type { Claim } from '../graph/types';

/** Keep event projections aligned when a generic tool replaces a backing claim. */
export function projectEventReplacement(db:Database,graph:GraphIngestor,oldId:string,claim:Claim) {
  const event=db.query<{entity_id:number;context:string},[string]>('SELECT entity_id,context FROM graph_events WHERE claim_id=?').get(oldId);
  if(event) {
    if(claim.subject!==event.entity_id || claim.predicate!=='EVENT_KIND' || typeof claim.value!=='string' || !claim.value.trim())
      throw new Error('Event existence claims must retain their event, EVENT_KIND predicate, and string kind');
    if(claim.context!==event.context) throw new Error('Use revise_event to change event context and its participants together');
    db.query('UPDATE graph_events SET kind=?,claim_id=? WHERE entity_id=?').run(claim.value,claim.id,event.entity_id);
  }
  const participant=db.query<{event_id:number;position:number},[string]>('SELECT event_id,position FROM graph_participants WHERE claim_id=?').get(oldId);
  if(participant) {
    const role=claim.predicate.startsWith('ROLE:') ? claim.predicate.slice(5) : '';
    if(claim.object===undefined || !role.trim()) throw new Error('Event participant claims require an entity object and ROLE:<role> predicate');
    graph.events.get(claim.subject);
    const position=claim.qualifiers?.position ?? participant.position;
    if(typeof position!=='number' || !Number.isInteger(position) || position<0) throw new Error('Participant position must be a nonnegative integer');
    db.query('UPDATE graph_participants SET event_id=?,entity_id=?,role=?,position=?,claim_id=? WHERE claim_id=?')
      .run(claim.subject,claim.object,role,position,claim.id,oldId);
  }
}
