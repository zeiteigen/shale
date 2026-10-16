import type { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { hamming, parseSimhash } from '../../lib/text/simhash';
import { contentWords, isStopWord, words } from '../../lib/text/tokenize';
import { canonicalRoots, hasTable } from './common';
import { loadThreads, matchMember } from './threads';

/**
 * Search relevance evaluation for scripts/search-eval.ts: metrics, near-duplicate keys, and the three query sets
 * (synthetic known-item, golden-thread names, hand-judged). Everything here reads; nothing is written.
 * Grades follow TREC conventions: 3 = the wanted item, 2 = relevant, 1 = marginal, 0 = not relevant.
 */
export type Judgments = Map<string, number>;
/** A ranker returns source ids, best first. */
export type Ranker = (db: Database, query: string, options: { limit: number }) => Promise<string[]> | string[];
export type QuerySet = 'known' | 'threads' | 'judged';
export interface EvalQuery { set: QuerySet; kind: string; query: string; judgments: Judgments; note?: string }

/** Minimum grade that counts as a hit for MRR (marginal results do not end the user's search). */
export const MRR_GRADE = 2;

// ---------------------------------------------------------------- metrics

export function reciprocalRank(ranked: readonly string[], judgments: Judgments, minGrade = MRR_GRADE): number {
  const index = ranked.findIndex(id => (judgments.get(id) ?? 0) >= minGrade);
  return index < 0 ? 0 : 1 / (index + 1);
}

/** nDCG@k with exponential gains (2^rel - 1) and log2 discounts; null when nothing is relevant. */
export function ndcg(ranked: readonly string[], judgments: Judgments, k: number): number | null {
  const gain = (rel: number) => 2 ** rel - 1, discount = (index: number) => Math.log2(index + 2);
  const ideal = [...judgments.values()].filter(rel => rel > 0).sort((a, b) => b - a).slice(0, k)
    .reduce((sum, rel, index) => sum + gain(rel) / discount(index), 0);
  if (!ideal) return null;
  const seen = new Set<string>();
  let dcg = 0;
  for (const [index, id] of ranked.slice(0, k).entries()) {
    if (seen.has(id)) continue; seen.add(id);
    dcg += gain(judgments.get(id) ?? 0) / discount(index);
  }
  return dcg / ideal;
}

/** Share of relevant (grade ≥ minGrade) sources found in the top k; null when nothing is relevant. */
export function recall(ranked: readonly string[], judgments: Judgments, k: number, minGrade = 1): number | null {
  const relevant = [...judgments].filter(([, rel]) => rel >= minGrade).map(([id]) => id);
  if (!relevant.length) return null;
  const top = new Set(ranked.slice(0, k));
  return relevant.filter(id => top.has(id)).length / relevant.length;
}

/** Share of pairs among the top k that are near-duplicates of each other (null with fewer than two results). */
export function duplicateRate(ranked: readonly string[], keysOf: (id: string) => readonly string[], k = 5): number | null {
  const top = ranked.slice(0, k), keys = top.map(id => new Set(keysOf(id)));
  let pairs = 0, duplicates = 0;
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
    pairs++;
    if (top[i] === top[j] || [...keys[i]!].some(key => keys[j]!.has(key))) duplicates++;
  }
  return pairs ? duplicates / pairs : null;
}

/** Nearest-rank percentile (p in 0..100). */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))]!;
}

const mean = (values: readonly (number | null)[]) => {
  const defined = values.filter((value): value is number => value !== null);
  return defined.length ? defined.reduce((a, b) => a + b, 0) / defined.length : null;
};

// ---------------------------------------------------------------- near-duplicates

/** The connector's thread identity: everything before the window fragment. */
export const threadKey = (uri: string) => uri.match(/^email:\/\/inbox\/thread\/([^#/?]+)/)?.[1] ?? null;

/** Lower-cased title without reply/forward prefixes or punctuation; too-short titles say nothing. */
export function normaliseTitle(title: string): string | null {
  const text = title.normalize('NFKC').toLocaleLowerCase().replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return text.length >= 4 ? text : null;
}

export interface NearDuplicates { keysOf(id: string): string[]; siblings(id: string): string[] }

/**
 * Near-duplicate keys per source: same email thread, same normalised title, or same SimHash cluster
 * (source_filter_simhash, when the source filter has fingerprinted this database; distance ≤ 3 within a producer).
 */
export function nearDuplicates(db: Database): NearDuplicates {
  const keys = new Map<string, string[]>(), members = new Map<string, string[]>();
  const add = (id: string, key: string) => {
    (keys.get(id) ?? keys.set(id, []).get(id)!).push(key);
    (members.get(key) ?? members.set(key, []).get(key)!).push(id);
  };
  for (const row of db.query<{ id: string; uri: string; title: string }, []>('SELECT id,uri,title FROM sources').all()) {
    const thread = threadKey(row.uri), title = normaliseTitle(row.title);
    if (thread) add(row.id, `thread:${thread}`);
    if (title) add(row.id, `title:${title}`);
  }
  if (hasTable(db, 'source_filter_simhash')) {
    const rows = db.query<{ source_id: string; producer: string; hash: string }, []>('SELECT source_id,producer,hash FROM source_filter_simhash').all();
    const parent = rows.map((_, index) => index);
    const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]!));
    const hashes = rows.map(row => parseSimhash(row.hash)), buckets = new Map<string, number[]>();
    rows.forEach((row, index) => { for (let band = 0; band < 4; band++) {
      const key = `${row.producer}\u001f${band}\u001f${row.hash.slice(band * 4, band * 4 + 4)}`;
      (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(index);
    } });
    for (const bucket of buckets.values()) for (let i = 0; i < bucket.length && i < 400; i++) for (let j = i + 1; j < bucket.length && j < 400; j++)
      if (hamming(hashes[bucket[i]!]!, hashes[bucket[j]!]!) <= 3) parent[find(bucket[i]!)] = find(bucket[j]!);
    const size = new Map<number, number>();
    rows.forEach((_, index) => size.set(find(index), (size.get(find(index)) ?? 0) + 1));
    rows.forEach((row, index) => { if (size.get(find(index))! > 1) add(row.source_id, `simhash:${find(index)}`); });
  }
  return {
    keysOf: id => keys.get(id) ?? [],
    siblings: id => [...new Set((keys.get(id) ?? []).flatMap(key => members.get(key) ?? []))].filter(other => other !== id),
  };
}

// ---------------------------------------------------------------- known-item queries

/** Types the default memory search deliberately hides (kept in step with sdk/memory/search.ts ACTIVITY_TYPES). */
export const HIDDEN_TYPES = ['browser_activity', 'browser_history', 'browser_session_analysis', 'web_session', 'browser_bookmark', 'bookmark',
  'history_batch', 'bookmarks_batch', 'history_item', 'bookmark_item'];
/** Entity families someone would type into a search box (events and episodes are descriptions, not names). */
const NAMEABLE = ['Person', 'Organization', 'Project', 'Opportunity', 'Product', 'Place', 'Course', 'Artifact', 'Community'];

/** Deterministic PRNG so a seed reproduces the same sample and queries. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Plausible query words: alphabetic (inner hyphens allowed), with a vowel, no character run, 3–24 letters. */
const queryable = (term: string) => /^\p{L}[\p{L}-]*\p{L}$/u.test(term) && term.length >= 3 && term.length <= 24 && !isStopWord(term)
  && /[aeiouyà-ÿ]/i.test(term) && !/(.)\1\1/.test(term);
const termsOf = (text: string) => words(text.replace(/\bhttps?:\/\/\S+|\S+@\S+\.\S+/g, ' ')).filter(queryable);
/** Retained lines are cut to a budget, so a word before an ellipsis or a line break may be a fragment ("unsubscri"). */
const candidateTerms = (text: string) => termsOf(text.replace(/[\p{L}\p{N}'’_-]+[ \t]*(…|\.\.\.|\n|$)/gu, ' '));

/** One deletion or transposition inside the word (first and last letters kept, as in real typing slips). */
export function typo(word: string, random: () => number): string {
  if (word.length < 5) return word;
  const at = 1 + Math.floor(random() * (word.length - 3));
  if (random() < 0.5 && word[at] !== word[at + 1]) return word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2);
  return word.slice(0, at) + word.slice(at + 1);
}

/** The part of a title a person remembers: before the " · " subtitle/date, without file extensions or bracketed asides. */
export const titleCore = (title: string) => title.split(' · ')[0]!.replace(/\.(md|png|jpe?g|pdf|txt|webp)$/i, '')
  .replace(/\([^)]*\)|\S+@\S+/g, ' ').replace(/\s+/g, ' ').trim();

/** Title as typed from memory: its core, at most eight words, with 1–2 words dropped. */
export function dropWords(title: string, random: () => number): string | null {
  const tokens = titleCore(title).split(/\s+/).filter(token => /[\p{L}\p{N}]/u.test(token)).slice(0, 8);
  if (contentWords(tokens.join(' ')).length < 3) return null;
  const drop = tokens.length >= 6 ? 2 : 1, kept = [...tokens];
  for (let n = 0; n < drop; n++) kept.splice(Math.floor(random() * kept.length), 1);
  const query = kept.join(' ');
  return contentWords(query).length >= 2 ? query : null;
}

/** Searchable sources: retained chunks, not a hidden activity type, not a metadata-only web capture. */
function eligibleSources(db: Database) {
  return db.query<{ id: string; title: string }, string[]>(`SELECT s.id,s.title FROM sources s
    WHERE s.type NOT IN (${HIDDEN_TYPES.map(() => '?').join(',')}) AND EXISTS(SELECT 1 FROM chunks c WHERE c.source_id=s.id)
      AND (s.type NOT IN ('web_page','public_web_page') OR coalesce((SELECT json_extract(o.metadata,'$.quality') FROM source_observations o
        WHERE o.source_id=s.id ORDER BY o.captured_at DESC,o.id DESC LIMIT 1),'unknown')<>'metadata')
    ORDER BY s.id`).all(...HIDDEN_TYPES);
}

/**
 * Known-item queries for a seeded sample of sources: rarest terms, a linked entity plus a rare term, the title with
 * words dropped, and a typo variant. The target is graded 3 and its near-duplicates 2, since returning a copy of the
 * wanted item is still a useful answer.
 */
export function knownItemQueries(db: Database, options: { sample: number; seed: number; duplicates: NearDuplicates }): EvalQuery[] {
  const random = mulberry32(options.seed);
  const eligible = eligibleSources(db);
  for (let i = eligible.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [eligible[i], eligible[j]] = [eligible[j]!, eligible[i]!]; }
  const sample = eligible.slice(0, options.sample), wanted = new Set(sample.map(source => source.id));
  // Document frequency over every source's retained text (the whole index, as the ranker sees it).
  const df = new Map<string, number>(), texts = new Map<string, string[]>();
  for (const row of db.query<{ source_id: string; text_content: string }, []>('SELECT source_id,text_content FROM chunks').iterate()) {
    (texts.get(row.source_id) ?? texts.set(row.source_id, []).get(row.source_id)!).push(row.text_content);
  }
  const ordered = new Map<string, string[]>();
  for (const [id, chunks] of texts) {
    const text = chunks.join('\n');
    for (const term of new Set(termsOf(text))) df.set(term, (df.get(term) ?? 0) + 1);
    if (wanted.has(id)) ordered.set(id, candidateTerms(text));
  }
  const root = canonicalRoots(db);
  const self = db.query<{ id: number }, []>("SELECT id FROM entities WHERE stable_id='self'").get()?.id;
  const selfRoot = self === undefined ? undefined : root(self);
  const entityOf = db.query<{ id: number }, [string]>('SELECT entity_id AS id FROM source_entities WHERE source_id=? ORDER BY entity_id');
  const entity = db.query<{ name: string; type: string }, [number]>('SELECT coalesce(display_name,name) AS name,type FROM entities WHERE id=?');

  // A title shared by many sources ("Daily Discussions Digest · <date>") names a series, not an item.
  const titleCount = new Map<string, number>();
  for (const row of db.query<{ title: string }, []>('SELECT title FROM sources').all()) {
    const key = normaliseTitle(titleCore(row.title)) ?? ''; titleCount.set(key, (titleCount.get(key) ?? 0) + 1);
  }

  const queries: EvalQuery[] = [];
  for (const source of sample) {
    const terms = ordered.get(source.id) ?? [];
    const tf = new Map<string, number>();
    for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
    const rare = [...tf.keys()].sort((a, b) => df.get(a)! - df.get(b)! || tf.get(b)! - tf.get(a)! || a.localeCompare(b));
    const judgments: Judgments = new Map(options.duplicates.siblings(source.id).map(id => [id, 2]));
    judgments.set(source.id, 3);
    const push = (kind: string, query: string | null) => { if (query) queries.push({ set: 'known', kind, query, judgments, note: source.id }); };

    const picked = rare.slice(0, 2 + Math.floor(random() * 3));
    const rareQuery = picked.length >= 2 ? terms.filter((term, index) => picked.includes(term) && terms.indexOf(term) === index).join(' ') : null;
    push('rare-terms', rareQuery);

    const names = [...new Set(entityOf.all(source.id).map(row => root(row.id)))].filter(id => id !== selfRoot)
      .map(id => entity.get(id)).filter((row): row is { name: string; type: string } => !!row && NAMEABLE.includes(row.type)
        && row.name.length >= 3 && row.name.length <= 60 && !/@|:\/\//.test(row.name) && contentWords(row.name).length > 0);
    if (names.length) {
      const name = names[Math.floor(random() * names.length)]!.name, inName = new Set(words(name));
      const term = rare.find(candidate => !inName.has(candidate));
      push('entity', term ? `${name} ${term}` : null);
    }

    const titleQuery = (titleCount.get(normaliseTitle(titleCore(source.title)) ?? '') ?? 0) <= 3 ? dropWords(source.title, random) : null;
    push('title', titleQuery);

    const base = rareQuery ?? titleQuery;
    if (base) {
      const longest = base.split(/\s+/).filter(word => /^\p{L}+$/u.test(word)).sort((a, b) => b.length - a.length)[0];
      const changed = longest && longest.length >= 5 ? typo(longest, random) : null;
      const tokens = base.split(/\s+/), at = tokens.indexOf(longest!);
      if (changed && changed !== longest) tokens[at] = changed;
      push('typo', changed && changed !== longest ? tokens.join(' ') : null);
    }
  }
  return queries;
}

// ---------------------------------------------------------------- thread and judged queries

/** "CCIR 1-on-1 research mentorship (2025)" -> "CCIR 1-on-1 research mentorship": years and asides are not search terms. */
export const threadQuery = (name: string) => name.replace(/\([^)]*\)/g, ' ').replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();

export function threadQueries(db: Database, path: string): { queries: EvalQuery[]; note?: string } {
  const { threads, note } = loadThreads(path);
  const queries = threads.map(thread => ({ set: 'threads' as const, kind: 'thread', query: threadQuery(thread.name), note: thread.name,
    judgments: new Map(thread.members.flatMap(member => matchMember(db, member)).map(source => [source.id, 2])) }));
  return { queries, note };
}

export interface JudgedFile { description?: string; queries: Array<{ query: string; kind?: string; note?: string; judgments: Array<{ sourceId: string; rel: number; title?: string }> }> }

export function judgedQueries(path: string): { queries: EvalQuery[]; note?: string } {
  if (!existsSync(path)) return { queries: [], note: `${path} is missing` };
  const file = JSON.parse(readFileSync(path, 'utf8')) as JudgedFile;
  return { queries: (file.queries ?? []).map(entry => ({ set: 'judged' as const, kind: entry.kind ?? 'judged', query: entry.query, note: entry.note,
    judgments: new Map(entry.judgments.map(judgment => [judgment.sourceId, judgment.rel])) })) };
}

// ---------------------------------------------------------------- running

export interface QueryResult {
  set: QuerySet; kind: string; query: string; note?: string; ranked: string[]; relevant: number;
  rr: number | null; ndcg5: number | null; ndcg10: number | null; recall50: number | null; dup5: number | null; ms: number; error?: string;
}

export async function runQueries(db: Database, ranker: Ranker, queries: readonly EvalQuery[], duplicates: NearDuplicates, limit = 50): Promise<QueryResult[]> {
  const results: QueryResult[] = [];
  for (const query of queries) {
    const relevant = [...query.judgments.values()].filter(rel => rel > 0).length;
    const started = performance.now();
    let ranked: string[] = [], error: string | undefined;
    try { ranked = [...await ranker(db, query.query, { limit })].slice(0, limit); }
    catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    const ms = performance.now() - started;
    results.push({ set: query.set, kind: query.kind, query: query.query, note: query.note, ranked, relevant, ms, error,
      rr: relevant ? reciprocalRank(ranked, query.judgments) : null, ndcg5: ndcg(ranked, query.judgments, 5),
      ndcg10: ndcg(ranked, query.judgments, 10), recall50: recall(ranked, query.judgments, 50), dup5: duplicateRate(ranked, duplicates.keysOf) });
  }
  return results;
}

export interface Summary { queries: number; judged: number; empty: number; errors: number; mrr: number | null; ndcg5: number | null; ndcg10: number | null;
  recall50: number | null; dup5: number | null; p50ms: number | null; p95ms: number | null }

/** Means over queries that have relevant sources; latency and duplicate rate over every query that returned results. */
export function summarise(results: readonly QueryResult[]): Summary {
  const judged = results.filter(result => result.relevant > 0 && !result.error);
  return { queries: results.length, judged: judged.length, empty: results.filter(result => !result.ranked.length).length,
    errors: results.filter(result => result.error).length,
    mrr: mean(judged.map(r => r.rr)), ndcg5: mean(judged.map(r => r.ndcg5)), ndcg10: mean(judged.map(r => r.ndcg10)),
    recall50: mean(judged.map(r => r.recall50)), dup5: mean(results.map(r => r.dup5)),
    p50ms: percentile(results.map(r => r.ms), 50), p95ms: percentile(results.map(r => r.ms), 95) };
}
