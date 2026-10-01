import type { Database } from "bun:sqlite";
import type { EventInput, EventRecord } from "./types";
import type { GraphEntities } from "./entities";
import type { GraphClaims } from "./claims";

export class GraphEvents {
  constructor(private db: Database, private entities: GraphEntities, private claims: GraphClaims) {}
  create(input: EventInput): EventRecord {
    if (!input.kind.trim()) throw new Error('Event kind is required');
    return this.db.transaction(() => {
      const entity = this.entities.create({stableId:input.stableId,name:input.name,type:'Event',namespace:input.namespace});
      if (this.db.query('SELECT 1 FROM graph_events WHERE entity_id=?').get(entity.id)) throw new Error('Event already exists');
      const existence=this.claims.add({namespace:input.namespace,subject:entity.id,predicate:'EVENT_KIND',value:input.kind,
        context:input.context,status:input.status,evidence:input.evidence,method:input.method,model:input.model,extractionRun:input.extractionRun});
      this.db.query('INSERT INTO graph_events(entity_id,kind,occurred_from,occurred_to,context,claim_id) VALUES(?,?,?,?,?,?)')
        .run(entity.id,input.kind,input.occurredFrom ?? null,input.occurredTo ?? null,input.context ?? '',existence.id);
      for (const [index,participant] of input.participants.entries()) {
        if (!participant.role.trim()) throw new Error('Participant role is required');
        const claim = this.claims.add({namespace:input.namespace,subject:entity.id,predicate:`ROLE:${participant.role}`,
          object:participant.entity,context:input.context,validFrom:input.occurredFrom,
          // A point event has no nonempty validity interval; occurrence is kept on the event.
          validTo:input.occurredTo === input.occurredFrom ? undefined : input.occurredTo,
          qualifiers:{position:participant.position ?? index},status:input.status,
          method:input.method,model:input.model,extractionRun:input.extractionRun,
          evidence:[...(input.evidence ?? []),...(participant.evidence ?? [])]});
        this.db.query('INSERT INTO graph_participants VALUES(?,?,?,?,?)')
          .run(entity.id,participant.entity,participant.role,participant.position ?? index,claim.id);
      }
      return this.get(entity.id);
    })();
  }
  get(id: number): EventRecord {
    const event = this.db.query<{kind:string;claim_id:string;context:string;occurred_from:number|null;occurred_to:number|null}, [number]>(
      'SELECT * FROM graph_events WHERE entity_id=?').get(id);
    if (!event) throw new Error('Unknown event');
    const participants = this.db.query<EventRecord['participants'][number], [number]>(
      'SELECT entity_id AS entity,role,position,claim_id AS claimId FROM graph_participants WHERE event_id=? ORDER BY position,role,entity_id').all(id);
    return {entity:this.entities.get(id),claimId:event.claim_id,kind:event.kind,context:event.context,
      occurredFrom:event.occurred_from,occurredTo:event.occurred_to,participants};
  }

  list(filter: {kind?:string;context?:string;from?:number;to?:number;statuses?:import('./types').ClaimStatus[];limit?:number;offset?:number} = {}) {
    const where:string[]=[];const params:(string|number)[]=[];
    for (const key of ['kind','context'] as const) if (filter[key]!==undefined) {where.push(`g.${key}=?`);params.push(filter[key]!);}
    for (const key of ['from','to'] as const) if (filter[key]!==undefined && !Number.isSafeInteger(filter[key])) throw new Error('Invalid event query date');
    if (filter.from!==undefined) {where.push('coalesce(g.occurred_to,g.occurred_from)>=?');params.push(filter.from);}
    if (filter.to!==undefined) {where.push('g.occurred_from<=?');params.push(filter.to);}
    if (filter.statuses) {
      if (!filter.statuses.length) return [];
      where.push(`c.status IN (${filter.statuses.map(()=>'?').join(',')})`);params.push(...filter.statuses);
    }
    const limit=Math.max(1,Math.min(200,Math.trunc(filter.limit ?? 100))),offset=Math.max(0,Math.trunc(filter.offset ?? 0));
    if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) throw new Error('Invalid event query bounds');
    params.push(limit,offset);
    return this.db.query<{entity_id:number}, (string|number)[]>(`SELECT g.entity_id FROM graph_events g JOIN graph_claims c ON c.id=g.claim_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY g.occurred_from,g.entity_id LIMIT ? OFFSET ?`).all(...params).map(row=>this.get(row.entity_id));
  }
}
