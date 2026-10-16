import type { Database } from 'bun:sqlite';
import type { ParsedQuery, QueryIntent } from './contracts';
import { STOP_WORDS } from '../../lib/text/tokenize';
import { loadPhraseDictionary, termStatistics } from '../../lib/text/terms';
import { COMMON_WORDS, gazetteerFor, tokenize as gazetteerTokens, type Gazetteer, type GazetteerEntry } from '../../lib/graph/gazetteer';
import { acronymKeys } from '../../lib/graph/identity-keys';
import { tagTemporal } from '../../lib/graph/temporal';

/**
 * Query understanding (search stage S3): the raw query string becomes a ParsedQuery for sdk/retrieval/engine.ts.
 * - Syntax: "quoted phrases" and the operators from:, origin:, type:, source:, before:, after:.
 * - Temporal: relative wording ("last week", "in June", "past 3 months") and dates the rule tagger finds become a
 *   date range; deadline wording (deadline, due, upcoming, next) sets `future`.
 * - Entities: the registry gazetteer links names, aliases, and upper-case acronyms (also on a title-cased copy, since
 *   queries are typed in lower case), and lower-case acronyms are looked up by their `key:acronym` alias. Each linked
 *   entity carries its other names as expansions ("UWHPC" also matches the spelled-out name) and an IDF weight from
 *   how many sources link it.
 * - Phrases: adjacent terms found in the corpus phrase dictionary (lib/text/terms.ts).
 * - Spelling: a SymSpell-style deletion index (edit distance 1 on both sides, so deletions, insertions,
 *   substitutions, and transpositions all meet) over the corpus vocabulary and registry name words, applied only to
 *   terms the index has (almost) never seen.
 * - Weights: IDF per term; terms in more than 40% of documents, and query filler ("say", "find"), are optional.
 * Pure reads; caches are per connection and keyed by the statistics they derive from. Works on scoped connections
 * (statistics tables are hidden there, so document frequencies come from the visible index instead).
 */

const FILLER = new Set(['email', 'emails', 'mail', 'message', 'messages', 'note', 'notes', 'say', 'said', 'says', 'tell', 'told', 'find', 'show', 'search', 'look', 'looking', 'regarding', 'anything', 'something',
  'stuff', 'thing', 'things', 'remember', 'mentioned', 'mention', 'talk', 'talked', 'about', 'me', 'my', 'mine', 'what', 'which', 'where',
  'when', 'who', 'whom', 'whose', 'why', 'how', 'did', 'does', 'do', 'was', 'were', 'is', 'are']);
const FUTURE = /\b(?:deadlines?|due|upcoming|next|soon|coming up|expir(?:e|es|ing|y))\b/i;
const OPTIONAL_SHARE = 0.4;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY = 86_400_000;

const QUERY_TOKEN = /[\p{L}\p{N}]+(?:[-'’.&+][\p{L}\p{N}]+)*/gu;

/** Lower-cased query tokens with offsets; possessive 's removed (FTS would read it as a separate "s"). */
export function queryTokens(text: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  for (const match of text.normalize('NFKC').matchAll(QUERY_TOKEN)) {
    const value = match[0].toLocaleLowerCase().replace(/['’]s$/, '').replace(/\.+$/, '');
    if (value) out.push({ text: value, start: match.index!, end: match.index! + match[0].length });
  }
  return out;
}

const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/** Inverse document frequency (BM25 form, always positive). */
export const idf = (documents: number, df: number) => Math.log(1 + (documents - df + 0.5) / (df + 0.5));

/** Document frequency in the visible fielded index (porter-stemmed, like the ranking itself). */
export function indexDf(db: Database, term: string): number {
  try {
    return db.query<{ n: number }, [string]>(`SELECT count(*) AS n FROM source_search_fts JOIN search_docs d ON d.id=source_search_fts.rowid
      WHERE source_search_fts MATCH ?`).get(`"${term.replace(/"/g, '""')}"`)?.n ?? 0;
  } catch { return 0; }
}

export function indexSize(db: Database): number {
  try { return db.query<{ n: number }, []>('SELECT count(*) AS n FROM search_docs').get()?.n ?? 0; } catch { return 0; }
}

// ---------------------------------------------------------------- spelling

/** Optimal string alignment distance (Damerau–Levenshtein without repeated edits), bounded early. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = [new Array(b.length + 1).fill(0).map((_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      let value = Math.min(rows[i - 1]![j]! + 1, row[j - 1]! + 1, rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, rows[i - 2]![j - 2]! + 1);
      row.push(value);
      best = Math.min(best, value);
    }
    if (best > max) return max + 1;
    rows.push(row);
  }
  return rows[a.length]![b.length]!;
}

const deletes = (word: string) => { const out = new Set<string>(); for (let i = 0; i < word.length; i++) out.add(word.slice(0, i) + word.slice(i + 1)); return out; };

export interface Speller { size: number; suggest(word: string): { word: string; df: number; distance: number } | null }

/** SymSpell index (distance-1 deletions of every vocabulary word, plus the word itself). */
export function buildSpeller(vocabulary: Iterable<[string, number]>): Speller {
  const index = new Map<string, string[]>();
  const df = new Map<string, number>();
  const add = (key: string, word: string) => { const list = index.get(key); if (!list) index.set(key, [word]); else if (list.at(-1) !== word && list.length < 64) list.push(word); };
  for (const [word, count] of vocabulary) {
    if (word.length < 3 || word.length > 30 || !/^\p{L}+$/u.test(word)) continue;
    df.set(word, Math.max(df.get(word) ?? 0, count));
    add(word, word);
    for (const key of deletes(word)) add(key, word);
  }
  return {
    size: df.size,
    suggest(word) {
      const max = word.length >= 6 ? 2 : 1;
      let best: { word: string; df: number; distance: number } | null = null;
      for (const key of [word, ...deletes(word)]) for (const candidate of index.get(key) ?? []) {
        if (candidate === word) continue;
        const distance = editDistance(word, candidate, max);
        if (distance > max) continue;
        const count = df.get(candidate) ?? 0;
        if (!best || distance < best.distance || (distance === best.distance && count > best.df)) best = { word: candidate, df: count, distance };
      }
      return best;
    },
  };
}

/** The registry gazetteer for this connection (scoped connections see only their visible registry). */
export function queryGazetteer(db: Database): Gazetteer {
  return gazetteerFor(db);
}

const spellers = new WeakMap<Database, { stamp: string; speller: Speller }>();

/** The connection's speller: corpus words (df ≥ 3) and registry name words, rebuilt when either changes. */
function spellerFor(db: Database): Speller {
  let stamp = '';
  try { stamp = db.query<{ value: string }, []>("SELECT value FROM search_terms_meta WHERE key='built_at'").get()?.value ?? ''; } catch { /* hidden or missing */ }
  let gazetteerSize = 0;
  try { gazetteerSize = queryGazetteer(db).size; } catch { /* no registry */ }
  stamp += `:${gazetteerSize}:${indexSize(db)}`;
  const cached = spellers.get(db);
  if (cached && cached.stamp === stamp) return cached.speller;
  const vocabulary: Array<[string, number]> = [];
  try { for (const row of db.query<{ term: string; df: number }, []>('SELECT term,df FROM search_terms WHERE df>=3').all()) vocabulary.push([row.term, row.df]); }
  catch { /* scoped: statistics are private */ }
  if (!vocabulary.length) {
    // No phrase statistics: the index's own (stemmed) vocabulary, through a TEMP fts5vocab table (not possible on a
    // query-only scoped connection, which then corrects towards registry names only).
    try {
      db.run('CREATE VIRTUAL TABLE IF NOT EXISTS temp.source_search_vocab USING fts5vocab(main, source_search_fts, row)');
      for (const row of db.query<{ term: string; doc: number }, []>('SELECT term,doc FROM temp.source_search_vocab WHERE doc>=3').all()) vocabulary.push([row.term, row.doc]);
    } catch { /* read-only or no index */ }
  }
  try {
    // Registry name words count as known vocabulary (df 3: enough to be a correction target, not to win over corpus words).
    for (const entry of queryGazetteer(db).entries) for (const token of entry.tokens) if (token.length >= 4) vocabulary.push([token, 3]);
  } catch { /* no registry */ }
  const speller = buildSpeller(vocabulary);
  spellers.set(db, { stamp, speller });
  return speller;
}

// ---------------------------------------------------------------- temporal

function monthRange(year: number, month: number) { return { start: Date.UTC(year, month, 1), end: Date.UTC(year, month + 1, 1) - 1 }; }

/** Relative wording the rule tagger leaves alone (it needs an anchor sentence, a query is not one). */
function relativeRange(text: string, now: number, future: boolean): { range: { start?: number; end?: number }; quote: string } | null {
  const lower = text.toLocaleLowerCase();
  const today = Math.floor(now / DAY) * DAY;
  const at = (pattern: RegExp) => pattern.exec(lower);
  let match: RegExpExecArray | null;
  if ((match = at(/\b(?:in the )?(?:last|past|previous) (\d{1,3}) (day|week|month|year)s?\b/))) {
    const unit = { day: 1, week: 7, month: 30.5, year: 365.25 }[match[2] as 'day']!;
    return { range: { start: now - Number(match[1]) * unit * DAY, end: now }, quote: match[0] };
  }
  if ((match = at(/\b(?:in the )?(next|coming) (\d{1,3}) (day|week|month)s?\b/))) {
    const unit = { day: 1, week: 7, month: 30.5 }[match[3] as 'day']!;
    return { range: { start: today, end: now + Number(match[2]) * unit * DAY }, quote: match[0] };
  }
  // "today"/"yesterday" only after a preposition: in "Deadline today" they are words of a subject line.
  if ((match = at(/\b(?:from|since|on|of) (today|yesterday)\b/))) return { range: match[1] === 'today' ? { start: today, end: today + DAY - 1 } : { start: today - DAY, end: today - 1 }, quote: match[0] };
  if ((match = at(/\b(this|last|past|previous|next) (week|month|year)\b/))) {
    const [, which, unit] = match;
    const span = unit === 'week' ? 7 * DAY : unit === 'month' ? 31 * DAY : 366 * DAY;
    if (which === 'this') return { range: { start: now - span, end: now + span }, quote: match[0] };
    if (which === 'next') return { range: { start: today, end: now + span }, quote: match[0] };
    return { range: { start: now - span, end: now }, quote: match[0] };
  }
  if ((match = at(/\b(?:in|during|since|from|before|after) ((?:19|20)\d{2})\b/))) {
    const year = Number(match[1]);
    const word = match[0].split(' ')[0];
    const range = word === 'since' || word === 'after' ? { start: Date.UTC(year, 0, 1) } : word === 'before' ? { end: Date.UTC(year, 0, 1) - 1 }
      : { start: Date.UTC(year, 0, 1), end: Date.UTC(year + 1, 0, 1) - 1 };
    return { range, quote: match[0] };
  }
  if ((match = at(/\b(?:in|during|since|from) (jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?!\s+(?:19|20)\d{2})/))) {
    const month = MONTHS.indexOf(match[1]!.slice(0, 3));
    const current = new Date(now);
    // The most recent such month (or the coming one for deadline wording).
    let year = current.getUTCFullYear();
    if (!future && month > current.getUTCMonth()) year--;
    if (future && month < current.getUTCMonth()) year++;
    const range = monthRange(year, month);
    return { range: match[0].startsWith('since') || match[0].startsWith('from') ? { start: range.start } : range, quote: match[0] };
  }
  return null;
}

function parseDateValue(value: string, now: number): { start: number; end: number } | null {
  const iso = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(value);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), iso[2] ? Number(iso[2]) - 1 : undefined, iso[3] ? Number(iso[3]) : undefined];
    if (m === undefined) return { start: Date.UTC(y, 0, 1), end: Date.UTC(y + 1, 0, 1) - 1 };
    if (d === undefined) return monthRange(y, m);
    return { start: Date.UTC(y, m, d), end: Date.UTC(y, m, d + 1) - 1 };
  }
  const tagged = tagTemporal(value, { anchor: now })[0];
  return tagged ? { start: tagged.start, end: tagged.end - 1 } : null;
}

// ---------------------------------------------------------------- entities

const canonicalGroup = (db: Database, id: number) => db.query<{ id: number }, [number]>(`WITH RECURSIVE m(id) AS (SELECT ? UNION SELECT e.id FROM entities e JOIN m ON e.canonical_id=m.id)
  SELECT id FROM m LIMIT 200`).all(id).map(row => row.id);

function selfRoot(db: Database): number | null {
  try {
    let id = db.query<{ id: number }, []>("SELECT id FROM entities WHERE stable_id='self'").get()?.id;
    for (let depth = 0; id !== undefined && depth < 32; depth++) {
      const parent = db.query<{ canonical_id: number | null }, [number]>('SELECT canonical_id FROM entities WHERE id=?').get(id)?.canonical_id;
      if (parent == null) break;
      id = parent;
    }
    return id ?? null;
  } catch { return null; }
}

/**
 * Other names of an entity's identity group, for query expansion: display names and plain/search aliases (an
 * acronym typed by the user expands to the spelled-out name), plus the typed name's own acronym. Generated
 * acronym keys of other members are left out: short codes like "FC3" match unrelated text.
 */
function expansions(db: Database, group: number[], surface: string): string[] {
  const names = new Map<string, string>();
  const ids = JSON.stringify(group);
  const own = fold(surface);
  const usable = (name: string) => name.length >= 4 && name.length <= 80 && !/:\/\/|@|^entity:|^[a-z-]+:[0-9a-f-]{12,}|\s·\s/i.test(name);
  const add = (name: string) => { const key = fold(name).replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); if (key && key !== own.replace(/[^\p{L}\p{N}]+/gu, ' ').trim() && !names.has(key)) names.set(key, name); };
  for (const row of db.query<{ name: string }, [string]>(`SELECT coalesce(display_name,name) AS name FROM entities WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(ids))
    if (usable(row.name)) add(row.name);
  for (const row of db.query<{ alias: string }, [string]>(`SELECT alias FROM graph_aliases WHERE entity_id IN (SELECT value FROM json_each(?))
    AND scope IN ('','search') ORDER BY length(alias) DESC LIMIT 40`).all(ids))
    if (usable(row.alias)) add(row.alias);
  for (const acronym of acronymKeys(surface)) if (acronym.length >= 3 && fold(acronym) !== own) add(acronym.toUpperCase());
  return [...names.values()].slice(0, 6);
}

const entryIndex = new WeakMap<Gazetteer, Map<string, GazetteerEntry[]>>();
function entriesByKey(gazetteer: Gazetteer) {
  let index = entryIndex.get(gazetteer);
  if (!index) {
    index = new Map();
    for (const entry of gazetteer.entries) { const key = entry.tokens.join(' '); const list = index.get(key); if (list) list.push(entry); else index.set(key, [entry]); }
    entryIndex.set(gazetteer, index);
  }
  return index;
}

/** Entities a single query word may name: rare words only, and an upper-case-only acronym only when it is not also a common word. */
const SINGLE_WORD_SHARE = 0.05;
const MAX_CANDIDATES_PER_SPAN = 3;

/**
 * Link registry entities over query word spans. Unlike text linking, a query is short and typed in lower case, and
 * an ambiguous name ("Alex") has no context: every candidate is kept (at most three, the most linked first), each
 * with the shared surface, and the engine credits a source for the best candidate it links.
 */
function linkEntities(db: Database, text: string, documents: number, dfOf: (term: string) => number,
  entities: ParsedQuery['entities'], covered: Set<number>, content: Array<{ text: string; start: number; end: number }>) {
  const gazetteer = queryGazetteer(db);
  const index = entriesByKey(gazetteer);
  const tokens = gazetteerTokens(text);
  const self = selfRoot(db);
  const spans: Array<{ start: number; end: number; quote: string; ids: number[] }> = [];
  for (let i = 0; i < tokens.length;) {
    let matched = 0;
    for (let size = Math.min(8, tokens.length - i); size >= 1 && !matched; size--) {
      const slice = tokens.slice(i, i + size);
      let entries = index.get(slice.map(token => token.norm).join(' '));
      if (!entries?.length) continue;
      const quote = text.slice(slice[0]!.start, slice.at(-1)!.end);
      if (size === 1) {
        const word = slice[0]!.norm;
        if (word.length < 3 || COMMON_WORDS.has(word) || STOP_WORDS.has(word)) continue;
        const upperTyped = /\p{Lu}.*\p{Lu}/u.test(quote) && quote === quote.toUpperCase();
        const rare = dfOf(word) <= Math.max(3, documents * SINGLE_WORD_SHARE);
        // An acronym typed in lower case ("uwhpc") still reads as one; an ordinary word ("essay") does not name "ESSAY".
        const acronymLike = (word.match(/[aeiouy]/g) ?? []).length <= 1 || /\d/.test(word);
        entries = entries.filter(entry => entry.upper ? upperTyped || (rare && acronymLike) : rare || /\p{Lu}/u.test(quote));
        if (!entries.length) continue;
      }
      spans.push({ start: slice[0]!.start, end: slice.at(-1)!.end, quote, ids: [...new Set(entries.map(entry => entry.entityId))] });
      matched = size;
    }
    i += matched || 1;
  }
  // Lower-case acronyms ("uwhpc") by their key alias.
  for (const token of content) {
    if (token.text.length < 3 || token.text.length > 8 || !/^[\p{L}\p{N}]+$/u.test(token.text)) continue;
    if (spans.some(span => span.start < token.end && span.end > token.start) || dfOf(token.text) > Math.max(3, documents * SINGLE_WORD_SHARE)) continue;
    const ids = db.query<{ entity_id: number }, [string]>("SELECT DISTINCT entity_id FROM graph_aliases WHERE scope='key:acronym' AND alias=? LIMIT 5").all(token.text)
      .map(row => canonicalRoot(db, row.entity_id));
    if (ids.length) spans.push({ start: token.start, end: token.end, quote: text.slice(token.start, token.end), ids: [...new Set(ids)] });
  }
  const linkedCount = db.query<{ n: number }, [string]>('SELECT count(DISTINCT source_id) AS n FROM source_entities WHERE entity_id IN (SELECT value FROM json_each(?))');
  const typeOf = db.query<{ type: string; name: string }, [number]>('SELECT type,coalesce(display_name,name) AS name FROM entities WHERE id=?');
  for (const span of spans) {
    const candidates = span.ids.map(id => canonicalRoot(db, id)).filter((id, at, all) => id !== self && all.indexOf(id) === at)
      .map(id => { const group = canonicalGroup(db, id); return { id, group, linked: linkedCount.get(JSON.stringify(group))?.n ?? 0, row: typeOf.get(id) }; })
      .filter(candidate => candidate.linked > 0 && candidate.row && !NOT_NAMED.has(candidate.row.type))
      .sort((a, b) => b.linked - a.linked || a.id - b.id).slice(0, MAX_CANDIDATES_PER_SPAN);
    for (const candidate of candidates) {
      if (entities.some(entity => entity.id === candidate.id)) continue;
      entities.push({ id: candidate.id, name: candidate.row!.name, surface: span.quote, weight: idf(Math.max(documents, candidate.linked), candidate.linked),
        expansions: expansions(db, candidate.group, span.quote) });
    }
    if (candidates.length) for (const token of content) if (token.start >= span.start && token.end <= span.end) covered.add(token.start);
  }
}

/** Entity types a query does not name (episodes are found by their members; source records are sources). */
const NOT_NAMED = new Set(['Episode', 'Source', 'ChatSession', 'Conversation', 'WebPage', 'SearchQuery']);


// ---------------------------------------------------------------- parse

export interface ParseOptions { now?: number }

export function parseQuery(db: Database, raw: string, options: ParseOptions = {}): ParsedQuery {
  const now = options.now ?? Date.now();
  const filters: ParsedQuery['filters'] = {};
  let dateRange: { start?: number; end?: number } | undefined;
  const narrow = (range: { start?: number; end?: number }) => {
    dateRange ??= {};
    if (range.start !== undefined) dateRange.start = Math.max(dateRange.start ?? -Infinity, range.start);
    if (range.end !== undefined) dateRange.end = Math.min(dateRange.end ?? Infinity, range.end);
  };
  // Operators.
  let text = raw.replace(/(^|\s)(from|origin|type|before|after|source):("[^"]*"|\S+)/gi, (_, lead: string, name: string, value: string) => {
    const clean = value.replace(/^"|"$/g, '').trim();
    const key = name.toLowerCase();
    if (!clean) return lead;
    if (key === 'from') filters.from = clean;
    else if (key === 'origin') filters.origin = clean;
    else if (key === 'type') filters.type = clean;
    else if (key === 'source') filters.sourceId = clean;
    else {
      const parsed = parseDateValue(clean, now);
      if (parsed && key === 'before') { filters.before = parsed.start - 1; narrow({ end: filters.before }); }
      else if (parsed) { filters.after = parsed.end + 1; narrow({ start: filters.after }); }
    }
    return lead;
  });
  // Quoted phrases.
  const phrases: ParsedQuery['phrases'] = [];
  text = text.replace(/"([^"]+)"/g, (_, inner: string) => {
    const tokens = queryTokens(inner).map(token => token.text);
    if (tokens.length) phrases.push({ text: tokens.join(' '), quoted: true });
    return ` ${inner} `;
  });
  const future = FUTURE.test(text);
  // Temporal wording.
  const relative = relativeRange(text, now, future);
  if (relative) { narrow(relative.range); text = text.replace(new RegExp(relative.quote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' '); }
  // Dates written out ("April 19th", "Nov 18, 2026") stay words: in a search box they are usually part of what is
  // looked for (a subject line), not a filter; explicit before:/after: operators are the way to filter by date.
  const tokens = queryTokens(text);
  const stats = termStatistics(db);
  const documents = stats.documents || indexSize(db);
  const content = tokens.filter(token => !STOP_WORDS.has(token.text) || /\d/.test(token.text));
  const dfCache = new Map<string, number>();
  const dfOf = (term: string) => {
    let value = dfCache.get(term);
    if (value === undefined) {
      const fromStats = stats.documents ? stats.df(term) : 0;
      value = fromStats || indexDf(db, term);
      dfCache.set(term, value);
    }
    return value;
  };

  // Entities: registry surfaces over the query's own word spans (longest first), then lower-case acronym keys.
  const entities: ParsedQuery['entities'] = [];
  const covered = new Set<number>();
  try { linkEntities(db, text, documents, dfOf, entities, covered, content); } catch { /* no registry on this connection */ }

  // Terms, with spelling correction for words the index has (almost) never seen.
  let speller: Speller | null = null;
  const terms: ParsedQuery['terms'] = [];
  for (const token of content) {
    if (terms.some(term => term.text === token.text)) continue;
    let df = dfOf(token.text);
    let corrected: string | undefined;
    const typed = text.slice(token.start, token.end);
    const acronymLike = /\p{Lu}.*\p{Lu}/u.test(typed) && typed === typed.toUpperCase();
    if (df <= 1 && token.text.length >= 4 && /^\p{L}+$/u.test(token.text) && !acronymLike && !covered.has(token.start) && indexDf(db, token.text) <= 1) {
      speller ??= spellerFor(db);
      const suggestion = speller.suggest(token.text);
      if (suggestion && suggestion.df >= Math.max(token.text.length <= 5 ? 10 : 3, df * 10)) { corrected = suggestion.word; df = Math.max(df, dfOf(suggestion.word) || suggestion.df); }
    }
    const optional = FILLER.has(token.text) || (documents > 0 && df / documents > OPTIONAL_SHARE);
    terms.push({ text: token.text, weight: idf(Math.max(documents, df), df), optional, ...(corrected ? { corrected } : {}) });
  }
  // Every term optional (e.g. "my resume" after filler): nothing would be required, so the content words are.
  if (terms.length && terms.every(term => term.optional)) for (const term of terms) if (!FILLER.has(term.text)) term.optional = false;

  // Dictionary phrases over adjacent content words (entity spans are matched by name already).
  const dictionary = loadPhraseDictionary(db);
  if (dictionary.documents) for (let i = 0; i < tokens.length; i++) for (const size of [4, 3, 2]) {
    const slice = tokens.slice(i, i + size);
    if (slice.length < size || STOP_WORDS.has(slice[0]!.text) || STOP_WORDS.has(slice.at(-1)!.text)) continue;
    if (slice.every(token => covered.has(token.start) || STOP_WORDS.has(token.text))) continue;
    const key = slice.map(token => token.text).join(' ');
    if (!dictionary.has(key) || phrases.some(phrase => phrase.text.includes(key))) continue;
    phrases.push({ text: key, quoted: false });
  }

  const required = terms.filter(term => !term.optional);
  const navigational = entities.length > 0 && required.length > 0 && content.every(token => covered.has(token.start) || terms.find(term => term.text === token.text)?.optional);
  const intent: QueryIntent = dateRange || future ? 'temporal' : navigational ? 'navigational' : 'informational';
  return { raw, terms, phrases, entities, filters, ...(dateRange ? { dateRange } : {}), ...(future ? { future } : {}), intent };
}

function canonicalRoot(db: Database, id: number) {
  let current = id;
  for (let depth = 0; depth < 32; depth++) {
    const parent = db.query<{ canonical_id: number | null }, [number]>('SELECT canonical_id FROM entities WHERE id=?').get(current)?.canonical_id;
    if (parent == null) break;
    current = parent;
  }
  return current;
}

