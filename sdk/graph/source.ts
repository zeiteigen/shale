import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { GraphIngestor } from '../graph';
import type { ClaimInput, EvidenceInput, EventInput, GraphValue } from './types';
import { serializeValue } from './values';

export function graphIdentity(namespace: string, kind: string, key: string): string {
  return `connector:${createHash('sha256').update(JSON.stringify([namespace,kind,key])).digest('hex')}`;
}

/** Bind assertions to a revision inside the source writer's database transaction. */
export class SourceGraph {
  readonly context: string;
  private hash: string;
  entities = new Set<number>();
  edgesCount = 0;
  constructor(private db: Database, private graph: GraphIngestor,
    readonly sourceId: string, readonly namespace: string, readonly observedAt?: number) {
    const source = db.query<{hash:string;uri:string}, [string]>('SELECT hash,uri FROM sources WHERE id=?').get(sourceId);
    if (!source) throw new Error(`Unknown connector source ${sourceId}`);
    this.hash = source.hash;
    this.context = source.uri;
  }

  entity(key: string, name: string, type: string, legacyKey?: string): number {
    const stableId = graphIdentity(this.namespace,type,key);
    let row = this.db.query<{id:number}, [string]>('SELECT id FROM entities WHERE stable_id=?').get(stableId);
    let legacyAvailable = false;
    if (!row && legacyKey) {
      const legacy = this.db.query<{id:number;type:string;stable_id:string}, [string,string]>(
        'SELECT id,type,stable_id FROM entities WHERE namespace=? AND name=?').get(this.namespace,legacyKey);
      legacyAvailable = !legacy;
      // A folder, domain, and topic may share a label. Never repurpose another identity.
      if (legacy && (legacy.type === type || legacy.type === 'Concept') && !legacy.stable_id.startsWith('connector:')) row = legacy;
      if (row) this.db.query('UPDATE entities SET stable_id=?,type=? WHERE id=?').run(stableId,type,row.id);
    }
    if (!row && legacyKey && legacyAvailable) {
      row = this.db.query<{id:number}, [string,string,string,string,string]>(
        'INSERT INTO entities(namespace,name,display_name,type,stable_id) VALUES(?,?,?,?,?) RETURNING id')
        .get(this.namespace,legacyKey,name,type,stableId);
    }
    const label = row && name === key ? this.graph.entities.get(row.id).name : name;
    const entity = this.graph.entities.create({stableId,name:label,type,namespace:this.namespace});
    this.graph.entities.addAlias(entity.id,key,'connector-key');
    this.entities.add(entity.id);
    return entity.id;
  }

  evidence(chunkIndex?: number, quote?: string, method = 'connector', stance: EvidenceInput['stance'] = 'supports'): EvidenceInput[] {
    return [{sourceId:this.sourceId,chunkIndex,quote,method,stance}];
  }

  /** An exact match is optional; absent matches remain source-level evidence. */
  quote(text: string): EvidenceInput[] {
    const chunks = this.db.query<{chunk_index:number;text_content:string}, [string]>(
      'SELECT chunk_index,text_content FROM chunks WHERE source_id=? AND chunk_type=\'verbatim\' ORDER BY chunk_index').all(this.sourceId);
    const chunk = chunks.find(chunk => chunk.text_content.includes(text));
    return chunk ? this.evidence(chunk.chunk_index,text) : this.evidence();
  }

  private linkLiveEvidence(subject: number, object: number | undefined, evidence: EvidenceInput[]) {
    for (const ev of evidence) {
      if (ev.sourceId !== this.sourceId || ev.chunkIndex === undefined) continue;
      for (const entity of [subject,object]) {
        if (entity !== undefined) this.db.query(`INSERT OR IGNORE INTO chunk_entities(chunk_id,entity_id)
          SELECT id,? FROM chunks WHERE source_id=? AND chunk_index=?`).run(entity,this.sourceId,ev.chunkIndex);
      }
    }
  }

  claim(subject: number, predicate: string, target: {object:number} | {value:GraphValue},
    options: Omit<ClaimInput,'id'|'subject'|'predicate'|'object'|'value'> = {}): string {
    if (predicate === "SOURCE_URI") this.graph.entities.addAlias(subject,this.sourceId,"source-id");
    const input: ClaimInput = {namespace:this.namespace,context:this.context,observedAt:this.observedAt,
      status:'accepted',method:'connector',evidence:this.evidence(),...options,subject,predicate,...target};
    const id = `source-claim:${createHash('sha256').update(serializeValue([
      this.sourceId,this.hash,input,
    ] as unknown as GraphValue)).digest('hex')}`;
    if (!this.db.query('SELECT 1 FROM graph_claims WHERE id=?').get(id)) this.graph.claims.add({...input,id});
    // Refresh live chunk linkage even when the source hash has not changed.
    this.linkLiveEvidence(subject,'object' in target ? target.object : undefined,input.evidence ?? []);
    return id;
  }

  link(subject: number, predicate: string, object: number,
    options: Omit<ClaimInput,'id'|'subject'|'predicate'|'object'|'value'> = {}): string {
    const id = this.claim(subject,predicate,{object},options);
    // Keep the existing graph renderer usable; claims are the authoritative record.
    this.db.query(`INSERT INTO edges(source_entity_id,target_entity_id,relation,weight)
      VALUES(?,?,?,?) ON CONFLICT(source_entity_id,target_entity_id,relation) DO UPDATE SET weight=excluded.weight`)
      .run(subject,object,predicate,options.strength ?? 1);
    this.edgesCount++;
    return id;
  }

  event(key: string, input: Omit<EventInput,'stableId'|'namespace'>): number {
    const stableId = graphIdentity(this.namespace,'Event',`${this.sourceId}:${this.hash}:${key}`);
    const existing = this.db.query<{id:number}, [string]>('SELECT id FROM entities WHERE stable_id=?').get(stableId);
    const event = existing ? this.graph.events.get(existing.id) : this.graph.events.create({
      namespace:this.namespace,context:this.context,status:'accepted',method:'connector',
      evidence:this.evidence(),...input,stableId});
    const evidence = input.evidence ?? this.evidence();
    this.linkLiveEvidence(event.entity.id,undefined,evidence);
    for (const participant of input.participants) this.linkLiveEvidence(event.entity.id,participant.entity,
      [...evidence,...(participant.evidence ?? [])]);
    return event.entity.id;
  }
}
