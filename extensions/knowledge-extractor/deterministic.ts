import type { ShaleSDK } from '@shale/sdk';
import { gazetteerFor, registryNeighbours, type GazetteerMatch } from '../../lib/graph/gazetteer';
import { detectMentions, type Mention } from '../../lib/graph/mention-typing';
import { sentenceAround, tagTemporal, temporalValue, type TemporalMention } from '../../lib/graph/temporal';
import { typeFamily } from '../../lib/graph/ontology';
import { connectorContext, type DigestSource } from './digest-context';
import type { Extraction, ExtractedClaim, ExtractedEntity, ExtractionChunk, Involvement } from './types';

/**
 * The deterministic tier of extraction: what can be read off a source window without a model.
 * - gazetteer links to registry entities, with the matched words as evidence (method `gazetteer`);
 * - new mentions typed by their form (method `pattern`); untyped ones are left to the model;
 * - dated claims HAS_DEADLINE / SCHEDULED_FOR from the temporal tagger, quoting the sentence (method `temporal`);
 * - the user's involvement from connector participants (method `connector`), when the participants settle it.
 * `complete` means every name-like phrase was linked or typed, so a model pass would add little beyond prose.
 */
export interface DeterministicExtraction {
  entities: ExtractedEntity[];
  claims: ExtractedClaim[];
  involvement?: Involvement;
  temporal: Array<{ chunkIndex: number; quote: string; kind: TemporalMention['kind']; grain: TemporalMention['grain']; value: string; subject?: string }>;
  /** Registry entities linked by the gazetteer (canonical ids). */
  linked: number[];
  /** Name-like phrases neither linked nor typed. */
  unresolved: string[];
  complete: boolean;
  /** First sentences of the window, for a digest when the model is skipped. */
  summary?: string;
}

/** Things that have deadlines or dates of their own (an Organization's deadline is usually its posting's). */
const DATED = new Set(['Opportunity', 'Event', 'Course', 'Project', 'Artifact']);

/**
 * Involvement from who took part, when it is settled by the connector: the user among the participants is a
 * participant (author when theirs is the first message); known participants without the user make an observer,
 * except in email, whose participants are senders only (mail addressed to the user does not list them).
 */
export function structuralInvolvement(source: Pick<DigestSource, 'origin' | 'type'>,
  people: Array<{ self: boolean; position?: number }>, self: number | undefined): Involvement | undefined {
  // Only connector-recorded participants count: entities a previous digest linked to the source are the model's reading.
  const recorded = people.filter(person => person.position !== undefined);
  if (!recorded.length || self === undefined || source.type !== 'chat_session') return undefined;
  const user = recorded.find(person => person.self);
  if (user) return user.position === 0 ? 'author' : 'participant';
  return source.origin === 'email' ? undefined : 'observer';
}

/** Leading prose of the window: the first sentences that are not headers, links, or boilerplate. */
export function extractiveSummary(chunks: ExtractionChunk[], max = 400): string | undefined {
  const sentences: string[] = [];
  let length = 0;
  for (const chunk of chunks) for (const line of chunk.text_content.split(/\n+/)) {
    const clean = line.trim();
    if (!clean || /^(?:from|to|cc|bcc|subject|date|sent|reply-to)\s*:/i.test(clean) || /https?:\/\/|^[<>[\]|#*-]/.test(clean) || clean.split(/\s+/).length < 4) continue;
    for (const sentence of clean.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? []) {
      const text = sentence.trim();
      if (text.split(/\s+/).length < 4) continue;
      if (length + text.length > max && sentences.length) return sentences.join(' ');
      sentences.push(text.slice(0, max));
      length += text.length + 1;
      if (sentences.length >= 3) return sentences.join(' ');
    }
  }
  return sentences.length ? sentences.join(' ') : undefined;
}

export function deterministicExtraction(sdk: ShaleSDK, source: DigestSource, chunks: ExtractionChunk[], first = true): DeterministicExtraction {
  const db = sdk.database;
  const { people, self } = connectorContext(sdk, source.source_id);
  const gazetteer = gazetteerFor(db);
  const context = people.map(person => person.id);
  const neighbours = (ids: number[]) => registryNeighbours(db, ids);
  const entities = new Map<string, ExtractedEntity>();
  const spans: Array<{ chunkIndex: number; start: number; end: number; key: string; type: string }> = [];
  const unresolved: string[] = [];
  const typedTypes = new Set(['Organization', 'Opportunity', 'Event', 'Course', 'Artifact', 'Project', 'Product', 'Place', 'Person']);
  const tagged = new Map(chunks.map(chunk => [chunk.chunk_index, tagTemporal(chunk.text_content, { anchor: source.created_at })]));
  for (const chunk of chunks) {
    const text = chunk.text_content;
    const dates = tagged.get(chunk.chunk_index) ?? [];
    const matches: GazetteerMatch[] = gazetteer.match(text, { context, neighbours });
    for (const match of matches) {
      const key = `g${match.entityId}`;
      const entity = entities.get(key) ?? { key, name: match.surface, type: match.type, entityId: match.entityId, method: 'gazetteer', mentions: [] };
      if (entity.mentions!.length < 3 && !entity.mentions!.some(item => item.quote === match.quote)) entity.mentions!.push({ chunkIndex: chunk.chunk_index, quote: match.quote });
      entities.set(key, entity);
      spans.push({ chunkIndex: chunk.chunk_index, start: match.start, end: match.end, key, type: match.type });
    }
    for (const mention of detectMentions(text)) {
      const end = mention.offset + mention.quote.length;
      const covered = spans.some(span => span.chunkIndex === chunk.chunk_index && span.start < end && span.end > mention.offset)
        || dates.some(date => date.offset < end && date.offset + date.quote.length > mention.offset);
      if (covered) continue;
      if (!mention.type) { if (mention.kind !== 'url') unresolved.push(mention.name); continue; }
      // LinkedIn slugs are keys, not names; they still count as identified.
      if (mention.kind === 'url' && mention.type !== 'Artifact') continue;
      if (!typedTypes.has(mention.type) || text.slice(mention.offset, end) !== mention.quote) continue;
      const key = `m:${mention.type}:${mention.name.toLowerCase()}`;
      const entity: ExtractedEntity = entities.get(key) ?? { key, name: mention.name, type: mention.type, method: 'pattern', mentions: [],
        ...(mention.url ? { urls: [mention.url] } : {}) };
      if (entity.mentions!.length < 3) entity.mentions!.push({ chunkIndex: chunk.chunk_index, quote: mention.quote });
      entities.set(key, entity);
      spans.push({ chunkIndex: chunk.chunk_index, start: mention.offset, end, key, type: mention.type });
    }
  }
  const claims: ExtractedClaim[] = [];
  const temporal: DeterministicExtraction['temporal'] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const text = chunk.text_content;
    for (const mention of tagged.get(chunk.chunk_index) ?? []) {
      if (mention.grain !== 'day' && mention.grain !== 'minute') continue;
      const sentence = sentenceAround(text, mention.offset, mention.offset + mention.quote.length);
      // The dated thing is the nearest dated entity in the same sentence.
      const candidates = spans.filter(span => span.chunkIndex === chunk.chunk_index && DATED.has(typeFamily(span.type))
        && span.start >= sentence.offset && span.end <= sentence.offset + sentence.quote.length);
      let subject = candidates.sort((a, b) => Math.abs(a.start - mention.offset) - Math.abs(b.start - mention.offset))[0];
      let evidence = sentence.quote, near = true;
      // Otherwise the dated thing named just before, in the same paragraph ("The X Program … Applications close Oct 15.").
      if (!subject) {
        const sentenceEnd = sentence.offset + sentence.quote.length;
        subject = spans.filter(span => span.chunkIndex === chunk.chunk_index && DATED.has(typeFamily(span.type)) && span.end <= sentence.offset
          && sentenceEnd - span.start <= 320 && !/\n\s*\n/.test(text.slice(span.start, sentence.offset))).sort((a, b) => b.start - a.start)[0];
        if (subject) { evidence = text.slice(subject.start, sentenceEnd); near = false; }
      }
      const value = mention.values.length > 1 ? `${temporalValue(mention.values[0]!, mention.grain)}/${temporalValue(mention.values.at(-1)!, mention.grain)}`
        : temporalValue(mention.start, mention.grain);
      temporal.push({ chunkIndex: chunk.chunk_index, quote: mention.quote, kind: mention.kind, grain: mention.grain, value, subject: subject?.key });
      if (!subject) continue;
      const predicate = mention.kind === 'deadline' ? 'HAS_DEADLINE' : 'SCHEDULED_FOR';
      // An event's date is when it happens; another thing's undifferentiated date is not evidence of a schedule.
      if (predicate === 'SCHEDULED_FOR' && typeFamily(subject.type) !== 'Event') continue;
      const id = `${subject.key}\u0000${predicate}\u0000${value}`;
      if (seen.has(id)) continue;
      seen.add(id);
      claims.push({ subject: subject.key, predicate, value, datatype: 'iso8601', method: 'temporal',
        confidence: (mention.relative || mention.floating ? 0.6 : 0.8) - (near ? 0 : 0.2),
        qualifiers: { grain: mention.grain, kind: mention.kind, expression: mention.quote, ...(mention.floating ? { floating: true } : {}),
          ...(mention.relative ? { relative: true } : {}) },
        evidence: [{ chunkIndex: chunk.chunk_index, quote: evidence }] });
    }
  }
  const involvement = structuralInvolvement(source, people, self);
  const hasText = chunks.some(chunk => chunk.text_content.trim());
  return {
    entities: [...entities.values()], claims, ...(involvement ? { involvement } : {}), temporal,
    linked: [...entities.values()].filter(entity => entity.entityId !== undefined).map(entity => entity.entityId!),
    unresolved: [...new Set(unresolved)].slice(0, 40),
    complete: hasText && unresolved.length === 0,
    ...(first ? { summary: extractiveSummary(chunks) } : {}),
  };
}

/** What shadow mode records: comparable with the model's entities, involvement, and dates. */
export function shadowVerdict(result: DeterministicExtraction) {
  return { entities: result.linked, mentions: result.entities.filter(entity => entity.entityId === undefined).map(entity => ({ name: entity.name, type: entity.type })),
    involvement: result.involvement ?? null, temporal: result.temporal, complete: result.complete, unresolved: result.unresolved.length };
}

/**
 * Fold the deterministic tier into a model extraction (active mode). A model entity that matched a gazetteer-linked
 * registry entity is committed as that entity; deterministic entities and dated claims the model lacks are added.
 */
export function mergeDeterministic(extraction: Extraction, result: DeterministicExtraction): Extraction {
  const nameKey = (entity: ExtractedEntity) => `${typeFamily(entity.type)}\u0000${entity.name.trim().toLowerCase()}`;
  const linkedById = new Map(result.entities.filter(entity => entity.entityId !== undefined).map(entity => [entity.entityId!, entity]));
  const linkedByName = new Map(result.entities.filter(entity => entity.entityId !== undefined).map(entity => [nameKey(entity), entity]));
  // A model entity the gazetteer also found (by registry match, or by the same name and type) is that registry entity.
  const entities = extraction.entities.map(entity => {
    const linked = (entity.match != null ? linkedById.get(entity.match) : undefined) ?? linkedByName.get(nameKey(entity));
    return linked ? { ...entity, entityId: linked.entityId, mentions: linked.mentions } : entity;
  });
  const byId = new Map(entities.filter(entity => entity.entityId !== undefined).map(entity => [entity.entityId!, entity.key]));
  const byName = new Map(entities.map(entity => [nameKey(entity), entity.key]));
  const keys = new Set(entities.map(entity => entity.key));
  // Each deterministic key maps to the model's entity for the same thing, or to a newly added entity.
  const rename = new Map<string, string>();
  const added: ExtractedEntity[] = [];
  for (const entity of result.entities) {
    const existing = entity.entityId !== undefined ? byId.get(entity.entityId) : byName.get(nameKey(entity));
    if (existing) { rename.set(entity.key, existing); continue; }
    let key = entity.key;
    while (keys.has(key)) key = `det:${key}`;
    keys.add(key);
    rename.set(entity.key, key);
    added.push({ ...entity, key });
  }
  const claims = result.claims.filter(claim => rename.has(claim.subject)).map(claim => ({ ...claim, subject: rename.get(claim.subject)! }));
  return { ...extraction, entities: [...entities, ...added], claims: [...extraction.claims, ...claims] };
}

/** An extraction made without the model, for windows the deterministic tier covers completely. */
export function deterministicOnly(result: DeterministicExtraction, first: boolean): Extraction {
  return { entities: result.entities, claims: result.claims, events: [],
    ...(first && result.summary ? { summary: result.summary } : {}), ...(first && result.involvement ? { involvement: result.involvement } : {}) };
}
