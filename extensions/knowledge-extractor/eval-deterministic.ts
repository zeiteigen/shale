/**
 * Offline evaluation of the deterministic extraction tier against stored model digests (read-only).
 *
 *   bun extensions/knowledge-extractor/eval-deterministic.ts data/production.db [sampleSize]
 *
 * - entities: gazetteer recall of graph_source_digests.entity_ids (canonicalised now) and the share of gazetteer
 *   links the model also produced (a precision proxy: the model misses things too). The registry already contains
 *   entities first seen in the sampled source, so "known" recall restricts to entities other digests also name.
 * - temporal: model date claims whose quote the tagger reads, and whether both land on the same day.
 * - involvement: structural involvement against the model's for conversations (email, Discord, …).
 * - predicates: share of model claims mapped onto a typed predicate (not RELATED_TO), by claims and distinct names.
 */
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import type { ShaleSDK } from '@shale/sdk';
import { canonicalPredicate } from '../../lib/graph/predicates';
import { tagTemporal } from '../../lib/graph/temporal';
import { isRegistryType } from '../../sdk/graph/registry';
import { deterministicExtraction, structuralInvolvement } from './deterministic';
import { connectorContext } from './digest-context';

const path = process.argv[2] ?? 'data/production.db';
const sampleSize = Number(process.argv[3] ?? 300);
const db = new Database(path, { readonly: true });
const sdk = { database: db } as unknown as ShaleSDK;
const pct = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}% (${n}/${d})` : 'n/a';

const parent = new Map(db.query<{ id: number; canonical_id: number }, []>('SELECT id,canonical_id FROM entities WHERE canonical_id IS NOT NULL').all()
  .map(row => [row.id, row.canonical_id]));
const canonical = (id: number) => { let current = id; for (let i = 0; i < 32 && parent.has(current); i++) current = parent.get(current)!; return current; };
const typeOf = new Map(db.query<{ id: number; type: string }, []>('SELECT id,type FROM entities').all().map(row => [row.id, row.type]));
const self = db.query<{ id: number }, []>("SELECT id FROM entities WHERE stable_id='self'").get()?.id;
const selfIds = new Set(self === undefined ? [] : [canonical(self)]);

interface Digest { source_id: string; revision_id: number; entity_ids: string; involvement: string; origin: string; type: string; title: string;
  uri: string; created_at: number; updated_at: number; digested_at: number }
const digests = db.query<Digest, []>(`SELECT d.source_id,d.revision_id,d.entity_ids,d.involvement,s.origin,s.type,s.title,s.uri,s.created_at,s.updated_at,d.digested_at
  FROM graph_source_digests d JOIN sources s ON s.id=d.source_id`).all();
// How many digests name each canonical entity: "known" entities are ones another source also names.
const digestCount = new Map<number, number>();
// When an entity was first named by any digest: "prior" entities were in the registry before this source's digest.
const firstSeen = new Map<number, number>();
for (const digest of digests) for (const id of new Set((JSON.parse(digest.entity_ids) as number[]).map(canonical))) {
  digestCount.set(id, (digestCount.get(id) ?? 0) + 1);
  firstSeen.set(id, Math.min(firstSeen.get(id) ?? Infinity, digest.digested_at));
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sample = [...digests].sort((a, b) => hash(a.source_id).localeCompare(hash(b.source_id))).slice(0, sampleSize);
const chunksOf = db.query<{ chunk_index: number; text_content: string }, [number]>(`SELECT chunk_index,text_content FROM graph_revision_chunks
  WHERE revision_id=? AND chunk_type='verbatim' ORDER BY chunk_index`);

let priorTotal = 0, priorFound = 0, llmTotal = 0, llmFound = 0, knownTotal = 0, knownFound = 0, linkedTotal = 0, linkedInLlm = 0, complete = 0, windows = 0;
let detClaims = 0, detTemporal = 0, mentionsTyped = 0;
const byOrigin = new Map<string, { llm: number; found: number; linked: number; agree: number }>();
const examples: string[] = [];
const started = performance.now();
for (const digest of sample) {
  // The extractor reads 12,000-character windows; evaluate the first two windows' worth.
  let budget = 24000;
  const chunks = [];
  for (const chunk of chunksOf.all(digest.revision_id)) {
    if (budget <= 0) break;
    const text = chunk.text_content.slice(0, budget);
    budget -= text.length;
    chunks.push({ chunk_index: chunk.chunk_index, text_content: text });
  }
  if (!chunks.length) continue;
  windows++;
  const result = deterministicExtraction(sdk, digest, chunks, true);
  const llm = new Set((JSON.parse(digest.entity_ids) as number[]).map(canonical)
    .filter(id => !selfIds.has(id) && isRegistryType(typeOf.get(id) ?? '') && typeOf.get(id) !== 'Episode'));
  const linked = new Set(result.linked.map(canonical).filter(id => !selfIds.has(id)));
  const found = [...llm].filter(id => linked.has(id)).length;
  const known = [...llm].filter(id => (digestCount.get(id) ?? 0) >= 2);
  llmTotal += llm.size; llmFound += found;
  const prior = [...llm].filter(id => (firstSeen.get(id) ?? Infinity) < digest.digested_at);
  priorTotal += prior.length; priorFound += prior.filter(id => linked.has(id)).length;
  knownTotal += known.length; knownFound += known.filter(id => linked.has(id)).length;
  linkedTotal += linked.size; linkedInLlm += [...linked].filter(id => llm.has(id)).length;
  const origin = byOrigin.get(digest.origin) ?? { llm: 0, found: 0, linked: 0, agree: 0 };
  origin.llm += llm.size; origin.found += found; origin.linked += linked.size; origin.agree += [...linked].filter(id => llm.has(id)).length;
  byOrigin.set(digest.origin, origin);
  if (result.complete) complete++;
  detClaims += result.claims.length; detTemporal += result.temporal.length;
  mentionsTyped += result.entities.filter(entity => entity.entityId === undefined).length;
  for (const claim of result.claims) if (examples.length < 15)
    examples.push(`${claim.predicate} ${JSON.stringify(claim.value)} subject=${result.entities.find(entity => entity.key === claim.subject)?.name} :: ${JSON.stringify((claim.qualifiers as { expression?: string })?.expression)}`);
}
const elapsed = performance.now() - started;

console.log(`\n== Entities (gazetteer pre-pass, ${windows} digested sources, ${(elapsed / Math.max(1, windows)).toFixed(1)} ms/source) ==`);
console.log(`recall of model digest entities:         ${pct(llmFound, llmTotal)}`);
console.log(`recall of known entities (>=2 digests):  ${pct(knownFound, knownTotal)}`);
console.log(`recall of prior entities (named by an earlier digest; no leakage from this source): ${pct(priorFound, priorTotal)}`);
console.log(`gazetteer links also in model set:       ${pct(linkedInLlm, linkedTotal)}`);
console.log(`windows fully covered (could skip model): ${pct(complete, windows)}`);
console.log(`typed new mentions: ${mentionsTyped}; deterministic dated claims: ${detClaims}; tagged expressions: ${detTemporal}`);
for (const [origin, stats] of [...byOrigin].sort((a, b) => b[1].llm - a[1].llm))
  console.log(`  ${origin.padEnd(10)} recall ${pct(stats.found, stats.llm).padEnd(22)} links-in-model ${pct(stats.agree, stats.linked)}`);

// Temporal: every model claim mapped to a date predicate, with a literal value and a quote.
console.log('\n== Temporal tagger vs model date claims ==');
const dateClaims = db.query<{ predicate: string; value_json: string; quote: string; created_at: number; subject_type: string }, []>(`
  SELECT c.predicate,c.value_json,ev.quote,s.created_at,e.type AS subject_type FROM graph_claims c
  JOIN graph_evidence ev ON ev.claim_id=c.id JOIN graph_source_revisions r ON r.id=ev.revision_id JOIN sources s ON s.id=r.source_id JOIN entities e ON e.id=c.subject_id
  WHERE c.method='llm' AND c.id LIKE 'knowledge-extraction:%:claim:%' AND c.value_json IS NOT NULL AND ev.quote IS NOT NULL
  GROUP BY c.id`).all()
  .filter(row => ['HAS_DEADLINE', 'SCHEDULED_FOR', 'STARTS_ON', 'ENDS_ON'].includes(canonicalPredicate(row.predicate, row.subject_type, null).predicate));
let tagged = 0, comparable = 0, sameDay = 0;
const disagreements: string[] = [];
for (const row of dateClaims) {
  const value = JSON.parse(row.value_json);
  const quoteDays = tagTemporal(row.quote, { anchor: row.created_at }).filter(m => m.grain === 'day' || m.grain === 'minute');
  if (!quoteDays.length) continue;
  tagged++;
  const valueDays = typeof value === 'string' ? tagTemporal(value, { anchor: row.created_at }).filter(m => m.grain === 'day' || m.grain === 'minute') : [];
  if (!valueDays.length) continue;
  comparable++;
  const days = new Set(quoteDays.flatMap(m => m.days));
  if (valueDays.some(m => m.days.some(day => days.has(day)))) sameDay++;
  else if (disagreements.length < 8) disagreements.push(`${row.predicate}=${JSON.stringify(value)} :: ${JSON.stringify(row.quote.slice(0, 120))}`);
}
console.log(`model date claims (mapped to HAS_DEADLINE/SCHEDULED_FOR/STARTS_ON/ENDS_ON): ${dateClaims.length}`);
console.log(`quote contains a day/minute expression the tagger reads: ${pct(tagged, dateClaims.length)}`);
console.log(`same day as the model's value (where the value is a date): ${pct(sameDay, comparable)}`);
for (const line of disagreements) console.log(`  differs: ${line}`);
console.log('deterministic dated claims (sample):');
for (const line of examples) console.log(`  ${line}`);

// Involvement: structural rule against the model for every conversation digest.
console.log('\n== Involvement (structural vs model, chat sessions) ==');
const matrix = new Map<string, number>();
let decided = 0, agree = 0, total = 0;
for (const digest of digests.filter(row => row.type === 'chat_session')) {
  total++;
  const { people, self } = connectorContext(sdk, digest.source_id);
  const structural = structuralInvolvement(digest, people, self);
  const key = `${digest.origin}: ${structural ?? 'undecided'} vs model ${digest.involvement}`;
  matrix.set(key, (matrix.get(key) ?? 0) + 1);
  if (!structural) continue;
  decided++;
  // "author" and "participant" both mean the user took part; the model rarely distinguishes them in chats.
  const took = (value: string) => value === 'author' || value === 'participant' ? 'took part' : value;
  if (took(structural) === took(digest.involvement)) agree++;
}
console.log(`decided structurally: ${pct(decided, total)}; agreement with model (author≈participant): ${pct(agree, decided)}`);
for (const [key, count] of [...matrix].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(5)}  ${key}`);

// Predicates: model-chosen claim predicates (digest claims; code-written ones such as SUMMARY are excluded).
console.log('\n== Predicate canonicalisation ==');
const claims = db.query<{ predicate: string; st: string; ot: string | null; literal: number }, []>(`SELECT c.predicate,s.type AS st,o.type AS ot,
  c.object_id IS NULL AS literal FROM graph_claims c JOIN entities s ON s.id=c.subject_id LEFT JOIN entities o ON o.id=c.object_id
  WHERE c.method='llm' AND c.id LIKE 'knowledge-extraction:%:claim:%'`).all();
let typed = 0;
const distinct = new Map<string, boolean>();
const targets = new Map<string, number>();
for (const claim of claims) {
  const mapped = canonicalPredicate(claim.predicate, claim.st, claim.literal ? null : claim.ot ?? undefined);
  const ok = mapped.predicate !== 'RELATED_TO';
  if (ok) typed++;
  distinct.set(claim.predicate, (distinct.get(claim.predicate) ?? false) || ok);
  targets.set(mapped.predicate, (targets.get(mapped.predicate) ?? 0) + 1);
}
console.log(`claims mapped to a typed predicate: ${pct(typed, claims.length)}`);
console.log(`distinct raw predicates mapped:      ${pct([...distinct.values()].filter(Boolean).length, distinct.size)}`);
console.log(`distinct predicates after mapping:   ${targets.size} (from ${distinct.size})`);
console.log(`  ${[...targets].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => `${name}:${count}`).join(' ')}`);
