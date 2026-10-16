import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { DEFAULT_FIELD_WEIGHTS, SEARCH_FIELDS, type ParsedQuery, type RankedSource, type SearchField } from './contracts';
import { parseQuery, queryTokens } from './query';
import { trigramCandidates } from './indexer';
import { DEFAULT_SEARCH_WEIGHTS, FEATURES, INVOLVEMENT, bestPassage, halfLifeDays, mergeWeights, proximity, recency, score, stemWord, upcoming,
  zeroFeatures, type FeatureVector, type Passage, type SearchWeights } from './features';
import { collapse, mmr, normaliseTitle, profile, threadKey, titleCore, type Profile } from './collapse';
import { hamming, parseSimhash, simhash, type SimHash } from '../../lib/text/simhash';
import { tagTemporal } from '../../lib/graph/temporal';
import { words } from '../../lib/text/tokenize';

/**
 * The search engine (stages S4–S5): candidates from several independent generators, features normalised to 0..1,
 * a linear score, then collapsing and MMR diversity. No model calls; every query reads through search_docs → sources
 * (or tables whose scoped views filter rows), writes nothing, and creates nothing, so it runs unchanged on a
 * restricted profile's connection and cannot surface a source that profile cannot see.
 *
 * Candidates (union, by source):
 *  1. BM25F over source_search_fts, relaxed step by step: every required unit (AND), then all but the lowest-IDF
 *     unit, then any unit (OR). A unit is a term (or its spelling correction), a quoted phrase, or a linked entity's
 *     span, which also matches the entity's other names (acronym ⇄ expansion);
 *  2. sources linked to query entities (their identity groups), and members of episodes INVOLVING them;
 *  3. trigram title/entity matches when a term was corrected or unknown;
 *  4. RM3-style pseudo-relevance feedback, only when fewer than five candidates were found.
 * Features: see features.ts. Weights: code defaults ← tuned weights in extension_state (scripts/search-tune.ts) ←
 * explicit `weights` (the knowledge-graph `searchWeights` setting, passed by the caller).
 */

export interface EngineFilters { origin?: string; type?: string; sourceId?: string; from?: string }

export interface SearchOptions {
  limit?: number;
  offset?: number;
  filters?: EngineFilters;
  /** Return per-feature contributions on each hit. */
  explain?: boolean;
  now?: number;
  /** Weight overrides on top of the code defaults and any tuned weights. */
  weights?: Partial<Record<string, unknown>> | null;
  /** Skip the tuned weights stored in extension_state (evaluation of the code defaults). */
  ignoreTuned?: boolean;
  /** A query parsed already (callers that also need the linked entities). */
  parsed?: ParsedQuery;
  /** Collapse near-duplicates (default true). */
  collapse?: boolean | Partial<Record<CollapseKind, boolean>>;
  /** MMR λ over the top 30 (1 disables diversity). */
  diversity?: number;
  fieldWeights?: Partial<Record<SearchField, number>>;
  /** Filled with per-phase timings in ms (diagnostics). */
  trace?: Record<string, number>;
}

export type CollapseKind = 'thread' | 'title' | 'template' | 'simhash';
export type SearchResults = RankedSource[] & { total: number; query: ParsedQuery };

const ACTIVITY_TYPES = ['browser_activity', 'browser_history', 'browser_session_analysis', 'web_session', 'browser_bookmark', 'bookmark', 'history_batch',
  'bookmarks_batch', 'history_item', 'bookmark_item'];
const STAGE_LIMIT = 250;
const OR_LIMIT = 200;
const RELAX_BELOW = 30;
const ENTITY_SOURCES = 300;
const EPISODES_PER_ENTITY = 20;
const PASSAGE_TOP = 60;
const SIMHASH_TOP = 60;
const STATE_EXTENSION = 'knowledge-graph';
const STATE_KEY = 'search-weights';
/** MMR λ over the top 30 (1 = no diversity). */
export const DEFAULT_DIVERSITY = 0.7;

const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
const json = (values: readonly unknown[]) => JSON.stringify(values);
const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
const hasRelation = (db: Database, name: string) => {
  try { return !!db.query("SELECT 1 FROM sqlite_temp_master WHERE name=?1 UNION ALL SELECT 1 FROM sqlite_master WHERE name=?1").get(name); } catch { return false; }
};

// ---------------------------------------------------------------- units

export interface Unit {
  key: string;
  /** Query word tokens the unit covers (for passages and coverage). */
  tokens: string[];
  /** Accepted stems per token, for passage matching. */
  stems: string[][];
  expr: string;
  weight: number;
  optional: boolean;
  /** Linked entities whose names the unit also matches. */
  entities: number[];
}

/** Turn the parsed query into matchable units: entity spans and quoted phrases absorb the terms they cover. */
export function buildUnits(query: ParsedQuery): Unit[] {
  const units: Unit[] = [];
  const absorbed = new Set<string>();
  const termOf = (token: string) => query.terms.find(term => term.text === token);
  const termExpr = (token: string) => { const term = termOf(token); return term?.corrected ? `(${quote(token)} OR ${quote(term.corrected)})` : quote(token); };
  const stemsOf = (token: string) => { const term = termOf(token); return [...new Set(token.split(/[-'’.&+]/).filter(Boolean).flatMap(part => [stemWord(part)])
    .concat(term?.corrected ? [stemWord(term.corrected)] : []))]; };
  const bySurface = new Map<string, ParsedQuery['entities']>();
  for (const entity of query.entities) (bySurface.get(entity.surface.toLocaleLowerCase()) ?? bySurface.set(entity.surface.toLocaleLowerCase(), []).get(entity.surface.toLocaleLowerCase())!).push(entity);
  for (const phrase of query.phrases.filter(phrase => phrase.quoted)) {
    const tokens = phrase.text.split(' ');
    tokens.forEach(token => absorbed.add(token));
    const weight = tokens.reduce((sum, token) => sum + (termOf(token)?.weight ?? 0), 0) || 1;
    units.push({ key: `phrase:${phrase.text}`, tokens, stems: tokens.map(stemsOf), expr: quote(phrase.text), weight, optional: false, entities: [] });
  }
  for (const [surface, entities] of bySurface) {
    const tokens = queryTokens(surface).map(token => token.text).filter(token => termOf(token) && !absorbed.has(token));
    if (!tokens.length) continue;
    tokens.forEach(token => absorbed.add(token));
    const own = tokens.length > 1 ? `(${tokens.map(termExpr).join(' AND ')})` : termExpr(tokens[0]!);
    const names = [...new Set(entities.flatMap(entity => entity.expansions ?? []))].filter(name => /[\p{L}\p{N}]/u.test(name)).slice(0, 8);
    const terms = tokens.map(token => termOf(token)!);
    units.push({ key: `entity:${surface}`, tokens, stems: tokens.map(stemsOf), expr: names.length ? `(${[own, ...names.map(quote)].join(' OR ')})` : own,
      weight: terms.reduce((sum, term) => sum + term.weight, 0), optional: terms.every(term => term.optional), entities: entities.map(entity => entity.id) });
  }
  for (const term of query.terms) {
    if (absorbed.has(term.text)) continue;
    units.push({ key: `term:${term.text}`, tokens: [term.text], stems: [stemsOf(term.text)], expr: termExpr(term.text), weight: term.weight, optional: term.optional, entities: [] });
  }
  return units;
}

// ---------------------------------------------------------------- candidates

export interface Candidate {
  sourceId: string; docId: number; title: string; type: string; origin: string; uri: string;
  /** When the source happened (digest occurrence, else creation). */
  at: number | null;
  range: [number | null, number | null];
  involvement: string | null;
  features: FeatureVector;
  /** Matched unit keys. */
  units: Set<string>;
  /** Matched query entity ids. */
  entities: number[];
  /** Linked entity ids (for diversity). */
  linked: number[];
  keys: string[];
  passage?: Passage | null;
  bm25: number;
}

export interface Prepared { query: ParsedQuery; units: Unit[]; candidates: Candidate[]; now: number }

function filterSql(filters: EngineFilters, bindings: SQLQueryBindings[]) {
  const parts: string[] = [];
  if (filters.origin) { parts.push('s.origin=?'); bindings.push(filters.origin); }
  if (filters.type) { parts.push('s.type=?'); bindings.push(filters.type); }
  if (filters.sourceId) { parts.push('(s.id=? OR s.uri=?)'); bindings.push(filters.sourceId, filters.sourceId); }
  if (!filters.type && !filters.sourceId) { parts.push(`s.type NOT IN (${ACTIVITY_TYPES.map(() => '?').join(',')})`); bindings.push(...ACTIVITY_TYPES); }
  return parts.length ? ` AND ${parts.join(' AND ')}` : '';
}

function ftsStage(db: Database, match: string, filters: EngineFilters, weights: number[], limit: number) {
  const bindings: SQLQueryBindings[] = [match];
  const where = filterSql(filters, bindings);
  try {
    return db.query<{ sourceId: string; docId: number; bm25: number }, SQLQueryBindings[]>(`SELECT d.source_id AS sourceId,d.id AS docId,
      bm25(source_search_fts,${weights.join(',')}) AS bm25 FROM source_search_fts JOIN search_docs d ON d.id=source_search_fts.rowid
      JOIN sources s ON s.id=d.source_id WHERE source_search_fts MATCH ?${where} ORDER BY bm25 LIMIT ?`).all(...bindings, limit);
  } catch { return []; }
}

/**
 * Doc ids among `ids` matching an FTS expression. The whole doclist is read and intersected here: FTS5 evaluates a
 * MATCH once per rowid when it is also constrained by `rowid IN (...)`, which is ten times slower. Ids outside the
 * (visible) candidate set are dropped, so a scoped connection learns nothing from them.
 */
function matching(db: Database, match: string, ids: ReadonlySet<number>): Set<number> {
  const out = new Set<number>();
  try { for (const row of db.query<{ id: number }, [string]>('SELECT rowid AS id FROM source_search_fts WHERE source_search_fts MATCH ?').all(match)) if (ids.has(row.id)) out.add(row.id); }
  catch { /* malformed expression */ }
  return out;
}

const groupMembers = (db: Database, id: number) => db.query<{ id: number }, [number]>(`WITH RECURSIVE m(id) AS (SELECT ? UNION SELECT e.id FROM entities e JOIN m ON e.canonical_id=m.id)
  SELECT id FROM m LIMIT 200`).all(id).map(row => row.id);

/**
 * Bounded personalised PageRank from the query entities over entity–source–episode links, two hops: a seed's own
 * sources, then members of episodes that involve it and sources of entities ASSOCIATED_WITH it. Mass splits by
 * degree (1/√deg keeps a well-linked seed from vanishing), restart mass stays on the seeds.
 */
function graphScores(db: Database, query: ParsedQuery, groups: Map<number, number[]>): Map<string, number> {
  const scores = new Map<string, number>();
  const add = (sourceId: string, value: number) => scores.set(sourceId, (scores.get(sourceId) ?? 0) + value);
  const total = query.entities.reduce((sum, entity) => sum + entity.weight, 0) || 1;
  const hasEpisodes = hasRelation(db, 'graph_claims');
  for (const entity of query.entities) {
    const seed = entity.weight / total;
    const members = json(groups.get(entity.id) ?? [entity.id]);
    const direct = db.query<{ source_id: string }, [string, number]>(`SELECT DISTINCT source_id FROM source_entities WHERE entity_id IN (SELECT value FROM json_each(?)) LIMIT ?`)
      .all(members, ENTITY_SOURCES * 2);
    for (const row of direct) add(row.source_id, 0.85 * seed / Math.sqrt(direct.length));
    if (!hasEpisodes) continue;
    try {
      const episodes = db.query<{ id: number }, [string, number]>(`SELECT DISTINCT subject_id AS id FROM graph_claims WHERE predicate='INVOLVES'
        AND status IN ('accepted','proposed') AND object_id IN (SELECT value FROM json_each(?)) LIMIT ?`).all(members, EPISODES_PER_ENTITY);
      for (const episode of episodes) {
        const sources = db.query<{ source_id: string }, [number]>(`SELECT DISTINCT json_extract(qualifiers,'$.sourceId') AS source_id FROM graph_claims
          WHERE predicate='PART_OF_EPISODE' AND status IN ('accepted','proposed') AND object_id=? LIMIT 100`).all(episode.id).filter(row => row.source_id);
        for (const row of sources) add(row.source_id, 0.85 * 0.85 * seed / Math.sqrt(episodes.length) / Math.sqrt(sources.length));
      }
      const associated = db.query<{ id: number; confidence: number | null }, [string, string]>(`SELECT CASE WHEN subject_id IN (SELECT value FROM json_each(?1)) THEN object_id ELSE subject_id END AS id,
        confidence FROM graph_claims WHERE predicate='ASSOCIATED_WITH' AND status IN ('accepted','proposed') AND object_id IS NOT NULL
        AND (subject_id IN (SELECT value FROM json_each(?1)) OR object_id IN (SELECT value FROM json_each(?2))) ORDER BY confidence DESC LIMIT 10`).all(members, members);
      for (const other of associated) {
        const sources = db.query<{ source_id: string }, [number, number]>('SELECT DISTINCT source_id FROM source_entities WHERE entity_id=? LIMIT ?').all(other.id, 100);
        for (const row of sources) add(row.source_id, 0.85 * 0.85 * seed * (other.confidence ?? 0.5) / Math.sqrt(associated.length) / Math.sqrt(sources.length));
      }
    } catch { /* claims hidden or missing */ }
  }
  return scores;
}

/** Tuned weights (and MMR λ) stored by scripts/search-tune.ts, when present and readable on this connection. */
function tunedState(db: Database): { weights: Record<string, unknown> | null; diversity?: number } {
  try {
    const row = db.query<{ value: string }, [string, string]>('SELECT value FROM extension_state WHERE extension_id=? AND state_key=?').get(STATE_EXTENSION, STATE_KEY);
    const parsed = row ? JSON.parse(row.value) : null;
    if (!parsed || typeof parsed !== 'object') return { weights: null };
    return { weights: parsed.weights ?? null, diversity: typeof parsed.diversity === 'number' ? parsed.diversity : undefined };
  } catch { return { weights: null }; }
}

/** The weights a search uses: code defaults ← tuned (extension_state) ← explicit overrides. */
export function searchWeights(db: Database, overrides?: Partial<Record<string, unknown>> | null, ignoreTuned = false): SearchWeights {
  return mergeWeights(DEFAULT_SEARCH_WEIGHTS, ignoreTuned ? null : tunedState(db).weights, overrides);
}

function searchDiversity(db: Database, options: SearchOptions): number {
  if (typeof options.diversity === 'number') return options.diversity;
  const tuned = options.ignoreTuned ? undefined : tunedState(db).diversity;
  return tuned !== undefined && tuned > 0 && tuned <= 1 ? tuned : DEFAULT_DIVERSITY;
}

/** Author line of a transcript ("[10:02] Nasser A. <x@y>: …") or the page host: what `from:` matches. */
function producerText(db: Database, sourceIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of db.query<{ source_id: string; text: string }, [string]>(`SELECT source_id,substr(text_content,1,600) AS text FROM chunks
    WHERE source_id IN (SELECT value FROM json_each(?)) AND chunk_index=1`).all(json(sourceIds))) {
    const author = row.text.match(/^\s*(?:•\s*)?\[\d{2}:\d{2}\]\s+([^\n]{1,120}?):\s/m)?.[1] ?? '';
    out.set(row.source_id, author);
  }
  return out;
}

/** Gather candidates and compute every feature. Pure reads. */
export function prepareSearch(db: Database, query: ParsedQuery, options: SearchOptions = {}): Prepared {
  const now = options.now ?? Date.now();
  let mark = performance.now();
  const lap = (name: string) => { if (options.trace) { const at = performance.now(); options.trace[name] = (options.trace[name] ?? 0) + at - mark; mark = at; } };
  const { before: _before, after: _after, ...textFilters } = query.filters;
  const filters: EngineFilters = { ...textFilters, ...stripUndefined(options.filters ?? {}) };
  const fieldWeights = SEARCH_FIELDS.map(field => options.fieldWeights?.[field] ?? DEFAULT_FIELD_WEIGHTS[field]);
  const units = buildUnits(query);
  const found = new Map<string, { docId: number }>();
  const note = (rows: Array<{ sourceId: string; docId: number }>) => { for (const row of rows) if (!found.has(row.sourceId)) found.set(row.sourceId, { docId: row.docId }); };

  // 1. BM25F with progressive relaxation.
  const required = units.filter(unit => !unit.optional);
  const core = required.length ? required : units;
  if (core.length) {
    const and = ftsStage(db, core.map(unit => unit.expr).join(' AND '), filters, fieldWeights, STAGE_LIMIT);
    note(and);
    if (and.length < RELAX_BELOW && core.length > 2) {
      const lowest = [...core].sort((a, b) => a.weight - b.weight)[0]!;
      note(ftsStage(db, core.filter(unit => unit !== lowest).map(unit => unit.expr).join(' AND '), filters, fieldWeights, STAGE_LIMIT));
    }
    if (units.length > 1 || !and.length) note(ftsStage(db, units.map(unit => unit.expr).join(' OR '), filters, fieldWeights, OR_LIMIT));
  }
  lap('fts');
  // 2. Entity-linked sources and episode members.
  const groups = new Map(query.entities.map(entity => [entity.id, groupMembers(db, entity.id)]));
  const graph = query.entities.length ? graphScores(db, query, groups) : new Map<string, number>();
  const linkedIds = [...graph.entries()].sort((a, b) => b[1] - a[1]).slice(0, ENTITY_SOURCES).map(([id]) => id);
  lap('graph');
  // 3. Trigram matches for corrected or unknown words.
  const trigram = new Map<string, number>();
  const contentText = query.terms.map(term => term.text).join(' ');
  if (contentText && query.terms.some(term => term.corrected || term.weight > 7.5) && query.terms.length <= 4) {
    try { for (const row of trigramCandidates(db, contentText, 30, filters)) { trigram.set(row.sourceId, row.score); if (!found.has(row.sourceId)) found.set(row.sourceId, { docId: row.docId }); } }
    catch { /* no trigram index */ }
  }
  // No text to match: the newest sources the query's own operators allow (a query of stop words returns nothing).
  const operators = Object.values(query.filters).some(value => value !== undefined) || !!query.dateRange;
  if (!units.length && !query.entities.length && operators) {
    const bindings: SQLQueryBindings[] = [];
    const where = filterSql(filters, bindings);
    note(db.query<{ sourceId: string; docId: number }, SQLQueryBindings[]>(`SELECT s.id AS sourceId,d.id AS docId FROM sources s JOIN search_docs d ON d.source_id=s.id
      WHERE 1${where} ORDER BY s.created_at DESC LIMIT ?`).all(...bindings, STAGE_LIMIT));
  }
  // 4. Pseudo-relevance feedback when nearly nothing matched.
  if (units.length && found.size + linkedIds.length < 5 && found.size > 0) {
    const expansion = feedbackTerms(db, [...found.keys()].slice(0, 10), query);
    if (expansion.length) note(ftsStage(db, [...units.map(unit => unit.expr), ...expansion.map(quote)].join(' OR '), filters, fieldWeights, 50));
  }

  lap('trigram+prf');
  // Metadata (and visibility: the join drops anything the connection cannot see).
  const ids = [...new Set([...found.keys(), ...linkedIds])];
  const bindings: SQLQueryBindings[] = [json(ids)];
  const where = filterSql(filters, bindings);
  const digests = hasRelation(db, 'graph_source_digests');
  const rows = ids.length ? db.query<{ id: string; docId: number; title: string; type: string; origin: string; uri: string; created_at: number;
    occurred_from: number | null; occurred_to: number | null; involvement: string | null }, SQLQueryBindings[]>(`SELECT s.id,d.id AS docId,s.title,s.type,s.origin,s.uri,s.created_at,
    ${digests ? 'g.occurred_from,g.occurred_to,g.involvement' : 'NULL AS occurred_from,NULL AS occurred_to,NULL AS involvement'}
    FROM sources s JOIN search_docs d ON d.source_id=s.id ${digests ? 'LEFT JOIN graph_source_digests g ON g.source_id=s.id' : ''}
    WHERE s.id IN (SELECT value FROM json_each(?))${where}`).all(...bindings) : [];
  // Metadata-only page captures are hidden by default, as in searchMemory, and penalised when asked for.
  const metadataOnly = new Set<string>();
  const pages = rows.filter(row => row.type === 'web_page' || row.type === 'public_web_page').map(row => row.id);
  if (pages.length) for (const row of db.query<{ id: string }, [string]>(`SELECT s.value AS id FROM json_each(?) s WHERE coalesce((SELECT json_extract(o.metadata,'$.quality')
    FROM source_observations o WHERE o.source_id=s.value ORDER BY o.captured_at DESC,o.id DESC LIMIT 1),'unknown')='metadata'`).all(json(pages))) metadataOnly.add(row.id);
  const defaultFilters = !filters.type && !filters.sourceId;
  let kept = rows.filter(row => !(defaultFilters && metadataOnly.has(row.id)));
  if (filters.from) {
    const authors = producerText(db, kept.map(row => row.id));
    const wanted = fold(filters.from);
    kept = kept.filter(row => fold(`${authors.get(row.id) ?? ''} ${row.uri}`).includes(wanted));
  }
  if (query.dateRange) {
    const { start = -Infinity, end = Infinity } = query.dateRange;
    const inRange = kept.filter(row => {
      const from = row.occurred_from ?? row.occurred_to ?? row.created_at, to = row.occurred_to ?? row.occurred_from ?? row.created_at;
      return to >= start && from <= end;
    });
    // Relative wording can be part of a subject ("…in June"): a range that leaves nothing is not applied.
    if (inRange.length || query.filters.before !== undefined || query.filters.after !== undefined) kept = inRange;
  }

  lap('metadata');
  const candidates: Candidate[] = kept.map(row => ({ sourceId: row.id, docId: row.docId, title: row.title, type: row.type, origin: row.origin, uri: row.uri,
    at: row.occurred_to ?? row.occurred_from ?? row.created_at, range: [row.occurred_from, row.occurred_to], involvement: row.involvement,
    features: zeroFeatures(), units: new Set(), entities: [], linked: [], keys: [], bm25: 0 }));
  if (!candidates.length) return { query, units, candidates, now };
  const docIds = new Set(candidates.map(candidate => candidate.docId));
  const byDoc = new Map(candidates.map(candidate => [candidate.docId, candidate]));
  const bySource = new Map(candidates.map(candidate => [candidate.sourceId, candidate]));

  // Text features.
  if (units.length) {
    try {
      for (const row of db.query<{ id: number; bm25: number }, [string]>(`SELECT rowid AS id,bm25(source_search_fts,${fieldWeights.join(',')}) AS bm25
        FROM source_search_fts WHERE source_search_fts MATCH ?`).all(units.map(unit => unit.expr).join(' OR '))) {
        const candidate = byDoc.get(row.id);
        if (candidate) candidate.bm25 = -row.bm25;
      }
    } catch { /* malformed expression: no text features */ }
    const max = Math.max(...candidates.map(candidate => candidate.bm25), 0);
    if (max > 0) for (const candidate of candidates) candidate.features.bm25f = Math.max(0, candidate.bm25) / max;
    const requiredWeight = core.reduce((sum, unit) => sum + unit.weight, 0) || 1;
    const allWeight = units.reduce((sum, unit) => sum + unit.weight, 0) || 1;
    const titleWeight = new Map<number, number>();
    for (const unit of units) {
      for (const id of matching(db, unit.expr, docIds)) {
        const candidate = byDoc.get(id)!;
        candidate.units.add(unit.key);
        if (core.includes(unit)) candidate.features.coverage += unit.weight / requiredWeight;
      }
      for (const id of matching(db, `{title} : (${unit.expr})`, docIds)) titleWeight.set(id, (titleWeight.get(id) ?? 0) + unit.weight / allWeight);
    }
    for (const [id, value] of titleWeight) byDoc.get(id)!.features.title = Math.min(1, value);
    // Phrases: quoted, dictionary, and the whole query as typed.
    const phrases = new Map<string, number>(query.phrases.map(phrase => [phrase.text, phrase.quoted ? 1 : 0.8]));
    const typed = queryTokens(query.raw.replace(/\b(?:from|origin|type|before|after|source):\S+/gi, ' ')).map(token => token.text);
    if (typed.length >= 2 && units.length >= 2) phrases.set(typed.join(' '), 1);
    for (const [phrase, strength] of phrases) {
      for (const id of matching(db, quote(phrase), docIds)) byDoc.get(id)!.features.phrase = Math.max(byDoc.get(id)!.features.phrase, 0.6 * strength);
      for (const id of matching(db, `{title} : ${quote(phrase)}`, docIds)) byDoc.get(id)!.features.phrase = Math.max(byDoc.get(id)!.features.phrase, strength);
    }
    // A title that is the query (navigational): exact match of its core.
    const wanted = normaliseTitle(typed.join(' '));
    if (wanted) for (const candidate of candidates) {
      const core = normaliseTitle(titleCore(candidate.title));
      if (core === wanted) candidate.features.title = 1;
      else if (core && core.startsWith(wanted)) candidate.features.title = Math.max(candidate.features.title, 0.8);
    }
  }
  for (const [sourceId, value] of trigram) { const candidate = bySource.get(sourceId); if (candidate) candidate.features.title = Math.max(candidate.features.title, 0.8 * value); }

  lap('text-features');
  // Entities linked to each candidate (entity match, diversity).
  const sourceIds = json(candidates.map(candidate => candidate.sourceId));
  for (const row of db.query<{ source_id: string; entity_id: number }, [string]>('SELECT source_id,entity_id FROM source_entities WHERE source_id IN (SELECT value FROM json_each(?))').all(sourceIds))
    bySource.get(row.source_id)?.linked.push(row.entity_id);
  if (query.entities.length) {
    const memberOf = new Map<number, number>();
    for (const [root, members] of groups) for (const member of members) memberOf.set(member, root);
    const bySurface = new Map<string, Array<{ id: number; weight: number }>>();
    for (const entity of query.entities) (bySurface.get(entity.surface.toLocaleLowerCase()) ?? bySurface.set(entity.surface.toLocaleLowerCase(), []).get(entity.surface.toLocaleLowerCase())!).push(entity);
    const totalWeight = [...bySurface.values()].reduce((sum, list) => sum + Math.max(...list.map(entity => entity.weight)), 0) || 1;
    for (const candidate of candidates) {
      const roots = new Set(candidate.linked.map(id => memberOf.get(id)).filter((id): id is number => id !== undefined));
      candidate.entities = [...roots];
      let value = 0;
      for (const list of bySurface.values()) value += Math.max(0, ...list.filter(entity => roots.has(entity.id)).map(entity => entity.weight));
      candidate.features.entity = value / totalWeight;
    }
    const max = Math.max(...candidates.map(candidate => graph.get(candidate.sourceId) ?? 0), 0);
    if (max > 0) for (const candidate of candidates) candidate.features.graph = (graph.get(candidate.sourceId) ?? 0) / max;
  }

  lap('entity-features');
  // Recency (or upcoming dates for deadline wording) and involvement.
  const deadlines = query.future ? claimedDates(db, sourceIds) : new Map<string, number[]>();
  for (const candidate of candidates) {
    const halfLife = halfLifeDays(candidate.type, candidate.origin);
    candidate.features.recency = recency(candidate.at, now, halfLife);
    // Deadline wording: an upcoming date in the source (claims, or the summary's own dates below), else very recent.
    if (query.future) candidate.features.upcoming = Math.max(upcoming(deadlines.get(candidate.sourceId) ?? [], now), recency(candidate.at, now, 21));
    candidate.features.involvement = candidate.involvement ? INVOLVEMENT[candidate.involvement] ?? 0 : 0.3;
  }
  qualityPenalties(db, candidates, metadataOnly);

  lap('recency+quality');
  // Passage features for the leading candidates under the current weights.
  const weights = searchWeights(db, options.weights, options.ignoreTuned);
  const leading = [...candidates].sort((a, b) => score(b.features, weights) - score(a.features, weights)).slice(0, PASSAGE_TOP);
  passages(db, leading, units, query, now);

  lap('passages');
  collapseKeys(db, candidates, weights);
  // Bulk: how many near-identical candidates a result stands for (notification floods, mass mailings).
  for (const group of collapse(candidates.map(candidate => ({ id: candidate.sourceId, score: 0, at: candidate.at, keys: candidate.keys, candidate })))) {
    const size = group.similar.length + 1;
    if (size < 2) continue;
    const value = Math.min(1, Math.log2(size) / 5);
    group.item.candidate.features.bulk = value;
    for (const id of group.similar) bySource.get(id)!.features.bulk = value;
  }
  lap('collapse-keys');
  return { query, units, candidates, now };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== '')) as Partial<T>;
}

/** Expansion terms from the top documents' text (RM3, relevance model weighted by rank). */
function feedbackTerms(db: Database, sourceIds: string[], query: ParsedQuery): string[] {
  const weights = new Map<string, number>();
  const own = new Set(query.terms.flatMap(term => [term.text, term.corrected ?? '']));
  sourceIds.forEach((sourceId, rank) => {
    const text = db.query<{ text: string }, [string]>('SELECT group_concat(text_content, char(10)) AS text FROM chunks WHERE source_id=?').get(sourceId)?.text ?? '';
    const counts = new Map<string, number>();
    const tokens = words(text).filter(word => word.length >= 4 && /^\p{L}+$/u.test(word) && !own.has(word));
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const [token, count] of counts) weights.set(token, (weights.get(token) ?? 0) + count / tokens.length / (rank + 1));
  });
  return [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([token]) => token);
}

/** Future dates of HAS_DEADLINE / SCHEDULED_FOR claims evidenced in each source. */
function claimedDates(db: Database, sourceIds: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  try {
    for (const row of db.query<{ source_id: string; value: string }, [string]>(`SELECT r.source_id,c.value_json AS value FROM graph_claims c
      JOIN graph_evidence ev ON ev.claim_id=c.id JOIN graph_source_revisions r ON r.id=ev.revision_id
      WHERE c.predicate IN ('HAS_DEADLINE','SCHEDULED_FOR') AND c.status IN ('accepted','proposed') AND r.source_id IN (SELECT value FROM json_each(?))`).all(sourceIds)) {
      const value = String(JSON.parse(row.value) ?? '').split('/')[0]!;
      const at = Date.parse(value.length === 7 ? `${value}-01` : value);
      if (Number.isFinite(at)) (out.get(row.source_id) ?? out.set(row.source_id, []).get(row.source_id)!).push(at);
    }
  } catch { /* no claims */ }
  return out;
}

/**
 * Quality penalties in 0..1: boilerplate email templates (P2), source-filter verdicts, metadata-only captures. Private
 * tables are empty views on scoped connections, so a restricted profile simply gets no penalty.
 */
function qualityPenalties(db: Database, candidates: Candidate[], metadataOnly: Set<string>) {
  const bySource = new Map(candidates.map(candidate => [candidate.sourceId, candidate]));
  const ids = json(candidates.map(candidate => candidate.sourceId));
  for (const candidate of candidates) if (metadataOnly.has(candidate.sourceId)) candidate.features.quality = 0.8;
  if (hasRelation(db, 'source_filter_decisions')) try {
    for (const row of db.query<{ source_id: string; decision: string }, [string]>(`SELECT source_id,decision FROM source_filter_decisions
      WHERE source_id IN (SELECT value FROM json_each(?)) AND decision<>'keep'`).all(ids)) {
      const candidate = bySource.get(row.source_id)!;
      candidate.features.quality = Math.max(candidate.features.quality, row.decision === 'remove' ? 1 : 0.4);
    }
  } catch { /* hidden */ }
  if (hasRelation(db, 'graph_email_template_members')) try {
    const threads = candidates.map(candidate => threadKey(candidate.uri)).filter(Boolean);
    if (threads.length) for (const row of db.query<{ conversation_id: string; verdict: string }, [string]>(`SELECT m.conversation_id,max(t.verdict='boilerplate') AS verdict
      FROM graph_email_template_members m JOIN graph_email_templates t ON t.template_id=m.template_id
      WHERE m.conversation_id IN (SELECT value FROM json_each(?)) GROUP BY m.conversation_id`).all(json(threads)))
      for (const candidate of candidates) if (row.verdict && threadKey(candidate.uri) === row.conversation_id) candidate.features.quality = Math.max(candidate.features.quality, 0.7);
  } catch { /* hidden */ }
}

/** Best passage and proximity for the leading candidates; future dates in the passage for deadline wording. */
function passages(db: Database, candidates: Candidate[], units: Unit[], query: ParsedQuery, now: number) {
  if (!candidates.length) return;
  const stems = units.flatMap(unit => unit.stems);
  const chunks = new Map<string, Array<{ chunkIndex: number; text: string }>>();
  for (const row of db.query<{ source_id: string; chunk_index: number; text: string }, [string]>(`SELECT source_id,chunk_index,text_content AS text FROM chunks
    WHERE source_id IN (SELECT value FROM json_each(?)) ORDER BY source_id,chunk_index`).all(json(candidates.map(candidate => candidate.sourceId))))
    (chunks.get(row.source_id) ?? chunks.set(row.source_id, []).get(row.source_id)!).push({ chunkIndex: row.chunk_index, text: row.text });
  for (const candidate of candidates) {
    const list = chunks.get(candidate.sourceId) ?? [];
    candidate.passage = stems.length ? bestPassage(list, stems) : null;
    candidate.features.proximity = proximity(candidate.passage, stems.length);
    if (query.future) {
      const summary = list.find(chunk => chunk.chunkIndex === 0)?.text ?? '';
      const dates = tagTemporal(summary.slice(0, 3000), { anchor: candidate.at ?? now }).filter(mention => mention.kind === 'deadline' || mention.kind === 'range').map(mention => mention.start);
      if (dates.length) candidate.features.upcoming = Math.max(candidate.features.upcoming, upcoming(dates, now));
    }
  }
}

/** Fingerprints of retained text by source and text length (the text changes only with a new memory version). */
const hashCache = new Map<string, SimHash | null>();

/** Collapse keys: email thread, normalised title, template, and SimHash cluster within a producer. */
function collapseKeys(db: Database, candidates: Candidate[], weights: SearchWeights) {
  for (const candidate of candidates) {
    const thread = threadKey(candidate.uri), title = normaliseTitle(candidate.title);
    if (thread) candidate.keys.push(`thread:${thread}`);
    if (title) candidate.keys.push(`title:${title}`);
  }
  if (hasRelation(db, 'graph_email_template_members')) try {
    const threads = candidates.map(candidate => threadKey(candidate.uri)).filter(Boolean);
    for (const row of db.query<{ conversation_id: string; template_id: string }, [string]>(`SELECT conversation_id,min(template_id) AS template_id
      FROM graph_email_template_members WHERE conversation_id IN (SELECT value FROM json_each(?)) GROUP BY conversation_id`).all(json(threads)))
      for (const candidate of candidates) if (threadKey(candidate.uri) === row.conversation_id) candidate.keys.push(`template:${row.template_id}`);
  } catch { /* hidden */ }
  // SimHash: the source filter's fingerprints when present, else fingerprints of the leading candidates' retained text.
  const leading = [...candidates].sort((a, b) => score(b.features, weights) - score(a.features, weights)).slice(0, SIMHASH_TOP);
  const prints: Array<{ candidate: Candidate; producer: string; hash: SimHash }> = [];
  let stored = false;
  if (hasRelation(db, 'source_filter_simhash')) try {
    const byId = new Map(leading.map(candidate => [candidate.sourceId, candidate]));
    for (const row of db.query<{ source_id: string; producer: string; hash: string }, [string]>(`SELECT source_id,producer,hash FROM source_filter_simhash
      WHERE source_id IN (SELECT value FROM json_each(?))`).all(json([...byId.keys()]))) { stored = true; prints.push({ candidate: byId.get(row.source_id)!, producer: row.producer, hash: parseSimhash(row.hash) }); }
  } catch { /* hidden */ }
  if (!stored) {
    const texts = new Map<string, string[]>();
    for (const row of db.query<{ source_id: string; text: string }, [string]>(`SELECT source_id,text_content AS text FROM chunks WHERE source_id IN (SELECT value FROM json_each(?))
      AND chunk_index>0 AND chunk_type='verbatim' ORDER BY source_id,chunk_index`).all(json(leading.map(candidate => candidate.sourceId))))
      (texts.get(row.source_id) ?? texts.set(row.source_id, []).get(row.source_id)!).push(row.text);
    const bodies = leading.map(candidate => {
      const raw = (texts.get(candidate.sourceId) ?? []).join('\n');
      const author = raw.match(/^\s*(?:•\s*)?\[\d{2}:\d{2}\]\s+([^\n]{1,120}?):\s/m)?.[1];
      const producer = `${candidate.origin}\u001f${(author ? (author.match(/<([^>]+@[^>]+)>/)?.[1] ?? author) : candidate.uri.match(/^https?:\/\/(?:www\.)?([^/:?#]+)/i)?.[1] ?? '').trim().toLocaleLowerCase()}`;
      return { candidate, producer, raw };
    });
    // Only producers with two or more leading candidates can hold a near-duplicate pair.
    const counts = new Map<string, number>();
    for (const body of bodies) counts.set(body.producer, (counts.get(body.producer) ?? 0) + 1);
    for (const { candidate, producer, raw } of bodies) {
      if ((counts.get(producer) ?? 0) < 2) continue;
      const body = raw.split('\n').map(line => line.replace(/^\s*(?:•\s*)?\[\d{2}:\d{2}\]\s+[^\n]{1,120}?:\s/, '')).join('\n');
      const key = `${candidate.sourceId}\u0000${raw.length}`;
      let hash = hashCache.get(key);
      if (hash === undefined) {
        hash = words(body).length < 25 ? null : simhash(body, { maxTokens: 800 });
        if (hashCache.size > 20_000) hashCache.clear();
        hashCache.set(key, hash);
      }
      if (hash) prints.push({ candidate, producer, hash });
    }
  }
  for (let i = 0; i < prints.length; i++) for (let j = i + 1; j < prints.length; j++) {
    const a = prints[i]!, b = prints[j]!;
    if (a.producer !== b.producer || hamming(a.hash, b.hash) > 3) continue;
    const key = `simhash:${[a.candidate.sourceId, b.candidate.sourceId].sort()[0]}`;
    // Transitive through the union-find in collapse(): one shared key per pair is enough.
    a.candidate.keys.push(key); b.candidate.keys.push(key);
  }
}

// ---------------------------------------------------------------- ranking

export interface Ranked { candidate: Candidate; score: number; similar: string[] }

/** Score, collapse, and diversify prepared candidates (cheap: the tuner calls this per weight vector). */
export function rankPrepared(prepared: Prepared, weights: SearchWeights, options: Pick<SearchOptions, 'collapse' | 'diversity'> = {}): Ranked[] {
  const scored = prepared.candidates.map(candidate => ({ candidate, score: score(candidate.features, weights) }));
  const kinds = collapseKinds(options.collapse);
  const groups = collapse(scored.map(entry => ({ id: entry.candidate.sourceId, score: entry.score, at: entry.candidate.at, entry,
    keys: entry.candidate.keys.filter(key => kinds.has(key.slice(0, key.indexOf(':')) as CollapseKind)) })));
  const ranked = groups.map(group => ({ candidate: group.item.entry.candidate, score: group.item.score, similar: group.similar }));
  const lambda = options.diversity ?? DEFAULT_DIVERSITY;
  const profiles = new Map<string, Profile>();
  return mmr(ranked, entry => entry.score, entry => {
    let value = profiles.get(entry.candidate.sourceId);
    if (!value) profiles.set(entry.candidate.sourceId, value = profile(entry.candidate.title, entry.candidate.linked));
    return value;
  }, lambda);
}

function collapseKinds(option: SearchOptions['collapse']): Set<CollapseKind> {
  const all: CollapseKind[] = ['thread', 'title', 'template', 'simhash'];
  if (option === false) return new Set();
  if (option === undefined || option === true) return new Set(all);
  return new Set(all.filter(kind => option[kind] !== false));
}

/**
 * Search sources: parse, gather, rank, collapse, diversify, and page. Returns one entry per (collapsed) source with
 * its best passage as chunkIndex; `total` counts collapsed hits.
 */
export function searchSources(db: Database, query: string, options: SearchOptions = {}): SearchResults {
  const limit = options.limit ?? 10, offset = options.offset ?? 0;
  const parsed = options.parsed ?? parseQuery(db, query, { now: options.now });
  const prepared = prepareSearch(db, parsed, options);
  const weights = searchWeights(db, options.weights, options.ignoreTuned);
  const ranked = rankPrepared(prepared, weights, { collapse: options.collapse, diversity: searchDiversity(db, options) });
  const page = ranked.slice(offset, offset + limit);
  const missing = page.filter(entry => entry.candidate.passage === undefined).map(entry => entry.candidate);
  if (missing.length) passages(db, missing, prepared.units, parsed, prepared.now);
  const fields = matchedFields(db, prepared.units, page.map(entry => entry.candidate.docId));
  const results = page.map(entry => {
    const candidate = entry.candidate;
    const hit: RankedSource = { sourceId: candidate.sourceId, score: Math.round(entry.score * 10000) / 10000, chunkIndex: candidate.passage?.chunkIndex ?? 0,
      similar: entry.similar, matched: { fields: fields.get(candidate.docId) ?? [], entities: candidate.entities,
        terms: prepared.units.filter(unit => candidate.units.has(unit.key)).flatMap(unit => unit.tokens) } };
    if (options.explain) hit.explain = Object.fromEntries(FEATURES.map(feature => [feature, Math.round(weights[feature] * candidate.features[feature] * 10000) / 10000]));
    return hit;
  });
  return Object.assign(results, { total: ranked.length, query: parsed });
}

function matchedFields(db: Database, units: Unit[], docIds: number[]): Map<number, SearchField[]> {
  const out = new Map<number, SearchField[]>();
  if (!units.length || !docIds.length) return out;
  const expr = units.map(unit => unit.expr).join(' OR ');
  const ids = new Set(docIds);
  for (const field of SEARCH_FIELDS) for (const id of matching(db, `{${field}} : (${expr})`, ids))
    (out.get(id) ?? out.set(id, []).get(id)!).push(field);
  return out;
}

/** Whether the fielded index has been built on this connection (searchMemory falls back to BM25 otherwise). */
export function searchIndexReady(db: Database): boolean {
  try { return !!db.query('SELECT 1 FROM search_docs LIMIT 1').get(); } catch { return false; }
}
