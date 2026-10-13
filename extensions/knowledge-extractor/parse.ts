import { validateValue } from '@shale/sdk/graph/values';
import { canonicalType } from '../../lib/graph/ontology';
import { textReferences, urlKey } from '../../lib/graph/identity-keys';
import type { Extraction, ExtractedEntity, ExtractedClaim, ExtractedEvent, DigestActivity, Involvement } from './types';
import { consistentDatatype } from './claim-datatype';

/** What a model reference may point at: listed registry/episode ids and text actually supplied. */
export interface ParseContext { registryIds?: Set<number>; episodeIds?: Set<number>; text?: string; sourceUri?: string }

const INVOLVEMENT = new Set<Involvement>(['none','observer','participant','author']);
const ACTIVITY_KINDS = new Set(['application','project','learning','event','purchase','social','admin','research','other']);
const str = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g,' ').slice(0,max) : undefined;
const strings = (value: unknown, count: number, max: number) => Array.isArray(value)
  ? [...new Set(value.map(item => str(item, max)).filter((item): item is string => Boolean(item)))].slice(0,count) : undefined;

/** Optional digest fields are cleaned rather than rejected: a stray value must not cost a retry. */
function digestEntityFields(entity: Record<string, unknown>, context: ParseContext) {
  const match = Number.isSafeInteger(entity.match) && context.registryIds?.has(entity.match as number) ? entity.match as number : null;
  const supplied = new Set([...textReferences(context.text ?? '').urls, ...(context.sourceUri ? [context.sourceUri] : [])]
    .map(url => urlKey(url)).filter(Boolean));
  const emails = new Set(textReferences(context.text ?? '').emails);
  // Identifying links must appear in the source; invented URLs would fabricate identity.
  const urls = strings(entity.urls, 8, 500)?.filter(url => supplied.has(urlKey(url)) || emails.has(url.toLowerCase()));
  const fields = { description: str(entity.description, 240), searchKeys: strings(entity.searchKeys, 8, 80),
    urls: urls?.length ? urls : undefined, match: match ?? undefined };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && !(Array.isArray(value) && !value.length)));
}

function digestActivity(value: unknown, context: ParseContext): DigestActivity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const activity = value as Record<string, unknown>;
  const label = str(activity.label, 120);
  if (!label) return null;
  const kind = str(activity.kind, 30)?.toLowerCase();
  const episode = activity.episode === 'new' ? 'new'
    : Number.isSafeInteger(activity.episode) && context.episodeIds?.has(activity.episode as number) ? activity.episode as number : null;
  const confidence = typeof activity.confidence === 'number' && activity.confidence >= 0 && activity.confidence <= 1 ? activity.confidence : undefined;
  return { label, kind: kind && ACTIVITY_KINDS.has(kind) ? kind : 'other', stage: str(activity.stage, 120), episode, confidence };
}

// JSON shapes emitted by the model are validated before committing any records.
export function parseExtraction(raw: string, context: ParseContext = {}): Extraction {
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
  const involvement = INVOLVEMENT.has(parsed.involvement) ? parsed.involvement as Involvement : undefined;
  return {
    entities:parsed.entities.map((e:ExtractedEntity)=>({key:e.key,name:e.name,type:canonicalType(e.type),aliases:e.aliases,
      ...digestEntityFields(e as unknown as Record<string, unknown>, context)})),
    claims:parsed.claims.map((c:ExtractedClaim)=>({subject:c.subject,predicate:c.predicate,object:c.object,value:c.value,
      datatype:consistentDatatype(c).datatype,unit:c.unit,language:c.language,polarity:c.polarity,context:c.context,qualifiers:c.qualifiers,
      validFrom:c.validFrom,validTo:c.validTo,observedAt:c.observedAt,confidence:c.confidence,evidence:c.evidence})),
    events:parsed.events.map((e:ExtractedEvent)=>({key:e.key,name:e.name,kind:e.kind,context:e.context,occurredFrom:e.occurredFrom,
      occurredTo:e.occurredTo,participants:e.participants.map(p=>({entity:p.entity,role:p.role,position:p.position})),evidence:e.evidence})),
    ...(str(parsed.summary, 1200) ? {summary:str(parsed.summary, 1200)} : {}),
    ...(involvement ? {involvement} : {}),
    ...(parsed.activity !== undefined ? {activity:digestActivity(parsed.activity, context)} : {}),
  };
}
