import { validateValue } from '@shale/sdk/graph/values';
import type { Extraction, ExtractedEntity, ExtractedClaim, ExtractedEvent } from './types';

// JSON shapes emitted by the model are validated before committing any records.
export function parseExtraction(raw: string): Extraction {
  const parsed=JSON.parse(raw.replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,''));
  for (const key of ['entities','claims','events']) if (!Array.isArray(parsed[key]) || parsed[key].length>100) throw new Error(`Invalid extraction ${key}`);
  const keys=new Set<string>();
  for (const entity of parsed.entities) {
    if (typeof entity.key!=='string' || !entity.key || keys.has(entity.key) || typeof entity.name!=='string' || !entity.name.trim() || typeof entity.type!=='string' || !entity.type.trim())
      throw new Error('Invalid extracted entity');
    if (entity.aliases!==undefined && (!Array.isArray(entity.aliases) || entity.aliases.some((a:unknown)=>typeof a!=='string'))) throw new Error('Invalid extracted aliases');
    keys.add(entity.key);
  }
  const evidence=(items:unknown)=> {
    if (!Array.isArray(items) || !items.length || items.length>30 || items.some(item=>!Number.isInteger(item.chunkIndex) || typeof item.quote!=='string' || !item.quote))
      throw new Error('Invalid extracted evidence');
  };
  for (const [index,claim] of parsed.claims.entries()) {
    if (!keys.has(claim.subject)) throw new Error(`Invalid extracted claim ${index}: subject ${JSON.stringify(claim.subject)} is not a declared entity key`);
    if (claim.object!==undefined && claim.value!==undefined)
      throw new Error(`Invalid extracted claim ${index}: both object and value are present; remove the unused field`);
    if (claim.object!==undefined && !keys.has(claim.object))
      throw new Error(`Invalid extracted claim ${index}: object ${JSON.stringify(claim.object)} is not a declared entity key; text literals belong in value`);
    if (!keys.has(claim.subject) || typeof claim.predicate!=='string' || !claim.predicate.trim() ||
      ((claim.object!==undefined)===(claim.value!==undefined)) || (claim.object!==undefined && !keys.has(claim.object)))
      throw new Error(`Invalid extracted claim ${index}: use declared entity keys, a nonempty predicate, and exactly one object or value (omit the unused field)`);
    evidence(claim.evidence);
    if (claim.value!==undefined) validateValue(claim.value);
    validateValue(claim.qualifiers ?? {});
    for (const key of ['validFrom','validTo','observedAt']) if (claim[key]!==undefined && !Number.isSafeInteger(claim[key])) throw new Error('Invalid extracted timestamp');
    if (claim.validFrom!==undefined && claim.validTo!==undefined && claim.validFrom>=claim.validTo) throw new Error('Invalid extracted validity interval');
    if (claim.confidence!==undefined && (!Number.isFinite(claim.confidence) || claim.confidence<0 || claim.confidence>1)) throw new Error('Invalid extraction confidence');
    if (claim.polarity!==undefined && ![1,-1].includes(claim.polarity)) throw new Error('Invalid extracted polarity');
    for (const key of ['context','datatype','unit','language']) if (claim[key]!==undefined && typeof claim[key]!=='string') throw new Error('Invalid extracted qualifier');
  }
  for (const event of parsed.events) {
    if (typeof event.key!=='string' || !event.key || keys.has(event.key) || typeof event.name!=='string' || typeof event.kind!=='string' || !Array.isArray(event.participants) || !event.participants.length || event.participants.length>100)
      throw new Error('Invalid extracted event');
    keys.add(event.key);evidence(event.evidence);
    for (const key of ['occurredFrom','occurredTo']) if (event[key]!==undefined && !Number.isSafeInteger(event[key])) throw new Error('Invalid event timestamp');
    if (event.occurredFrom!==undefined && event.occurredTo!==undefined && event.occurredFrom>event.occurredTo) throw new Error('Invalid event interval');
    for (const participant of event.participants) if (!keys.has(participant.entity) || typeof participant.role!=='string' || !participant.role.trim()) throw new Error('Invalid extracted participant');
  }
  if (parsed.entities.length+parsed.claims.length+parsed.events.reduce((sum:number,e:ExtractedEvent)=>sum+1+e.participants.length,0)>300)
    throw new Error('Extraction exceeds record budget');
  // Discard undeclared fields such as model-supplied status, namespace, or dependencies.
  return {
    entities:parsed.entities.map((e:ExtractedEntity)=>({key:e.key,name:e.name,type:e.type,aliases:e.aliases})),
    claims:parsed.claims.map((c:ExtractedClaim)=>({subject:c.subject,predicate:c.predicate,object:c.object,value:c.value,
      datatype:c.datatype,unit:c.unit,language:c.language,polarity:c.polarity,context:c.context,qualifiers:c.qualifiers,
      validFrom:c.validFrom,validTo:c.validTo,observedAt:c.observedAt,confidence:c.confidence,evidence:c.evidence})),
    events:parsed.events.map((e:ExtractedEvent)=>({key:e.key,name:e.name,kind:e.kind,context:e.context,occurredFrom:e.occurredFrom,
      occurredTo:e.occurredTo,participants:e.participants.map(p=>({entity:p.entity,role:p.role,position:p.position})),evidence:e.evidence})),
  };
}
