import type { Database } from 'bun:sqlite';
import type { Keyphrase, PhraseDictionary } from '../../sdk/retrieval/contracts';
import { g2 as dunning } from '../graph/association';
import { gazetteerFor } from '../graph/gazetteer';
import { STOP_WORDS } from './tokenize';
import { BOILERPLATE, boilerplateStripper, producerOf as boilerplateProducer } from '../../sdk/retrieval/boilerplate';

/**
 * Corpus-aware term statistics (search stage S2).
 *
 * - A phrase dictionary over every source's retained text (title + verbatim snippets): stopword-bounded 1–4-grams
 *   inside punctuation fragments, scored for termhood with C-value (Frantzi, Ananiadou & Mima 2000: frequency
 *   corrected for nesting inside longer terms) and Dunning G² collocation strength (the phrase against
 *   independence of its parts). Unigram document frequencies, and per-producer (sender/host) frequencies, are kept
 *   beside it.
 * - Per-source keyphrases: phraseness × informativeness (BM25 weight against the corpus, contrasted with the
 *   producer's own background so a sender's recurring words stop being every message's topic) × an entity boost
 *   when the phrase names a registry entity.
 *
 * The dictionary is rebuilt in full when any source memory changed: the corpus is small (≈3k sources, ≈7 MB of
 * retained text, 12 kB per source at most) and a rebuild takes about two seconds, whereas an exactly incremental
 * df/C-value would need every source's full n-gram set stored (millions of rows) because a phrase can cross the
 * df ≥ 2 threshold, and C-value nesting changes, when any other source changes. Tables are private operational
 * state; scoped profiles see them as missing, and every reader falls back to "no statistics".
 */

/** G² critical value for p < 0.001, one degree of freedom. */
export const G2_CRITICAL = 10.83;
/** C-value floor for keeping a multiword phrase that is not a significant collocation. */
export const C_VALUE_MIN = 3;
const MAX_WORDS = 4;
/** Tokens examined per document; retained text is capped upstream, this only guards pathological inputs. */
const MAX_DOC_TOKENS = 20000;
/** Per-producer contrast needs enough of the producer's documents to say what is routine for it. */
const PRODUCER_MIN_DOCS = 5;
/** Minimum corpus size before keyphrase scores are trusted over single-document YAKE. */
export const MIN_DICTIONARY_DOCUMENTS = 50;
/** Default producer-contrast weight (see the offline topic-agreement evaluation in the S2 report). */
export const DEFAULT_CONTRAST = 0.5;

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}'’_+#.-]*[\p{L}\p{N}+#]|[\p{L}\p{N}]/gu;
const NOISE = /https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+\.[\w.-]+|<[^>]*>|\[\d{1,2}:\d{2}\]/g;
const FRAGMENT = /[,;:()"“”!?|/\\[\]{}–—…]+|\s[-•*]\s|\.(?:\s|$)/;
/** Connector metadata lines (mail headers, visit records): they describe the capture, not its content. */
const METADATA = /^\s*(?:subject|from|to|cc|bcc|date|sent|reply-to|message[- ]id|title|url|domain|page|visit|visits|visited|visit count|typed count|last visit|content origin|content observed at|extraction quality):/i;
/** Transcript line prefix "[hh:mm] Author: " (chat and mail windows). */
const SPEAKER = /^\s*(?:•\s*)?\[\d{2}:\d{2}\]\s+([^\n]{1,120}?):\s/;

/** Crude suffix stripping, only to treat "photo"/"photos" as one topic (same rule as extractKeyphrases). */
const stem = (key: string) => key.length > 4 ? key.replace(/(?:ies|es|s|ing|ed)$/, '') : key;
const VERBAL = /^\p{Ll}+(?:ing|ed|ly)$/u;

export interface TermToken { raw: string; key: string }

const keyOf = (raw: string) => raw.normalize('NFKC').toLocaleLowerCase().replace(/['’]s$/, '');

/** Honorifics and mail fillers bound phrases like stop words ("followed up with Dr", "Dear Ali"). */
const FILLERS = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'dear', 'hi', 'hello', 'hey', 'thanks', 'regards', 'best', 'sincerely']);

/** A token that can neither start nor end a candidate: stop words, numbers, and tracking-id-like strings. */
export function isBoundaryStop(key: string, excluded?: ReadonlySet<string>) {
  return STOP_WORDS.has(key) || FILLERS.has(key) || key.length < 2 || key.length > 40 || /^[\d.,:+#'’_-]+$/.test(key)
    || (excluded?.has(key) ?? false) || (key.length >= 12 && /\d/.test(key) && /\p{L}/u.test(key)) || /\d\p{L}{2,}\d/u.test(key);
}

/** Text worth counting: metadata lines, speaker prefixes, date separators, links, and addresses removed. */
export function retainedText(text: string): string {
  return text.split('\n').map(line => line.replace(SPEAKER, ''))
    .filter(line => !METADATA.test(line) && !/^\s*— \d{4}-\d{2}-\d{2} —\s*$/.test(line)).join('\n').replace(NOISE, ' ');
}

/** Punctuation fragments of word tokens; a phrase never spans a comma, a colon, a sentence end, or a line. */
export function termFragments(text: string, maxTokens = MAX_DOC_TOKENS): TermToken[][] {
  const out: TermToken[][] = [];
  let total = 0;
  for (const line of retainedText(text).split(/\n+/)) for (const fragment of line.split(FRAGMENT)) {
    const tokens = (fragment.match(TOKEN) ?? []).map(raw => ({ raw, key: keyOf(raw) }));
    if (!tokens.length) continue;
    out.push(tokens);
    if ((total += tokens.length) >= maxTokens) return out;
  }
  return out;
}

/** Visit every stopword-bounded n-gram (1..maxWords) of the fragments. */
function eachCandidate(fragments: TermToken[][], visit: (keys: string[], tokens: TermToken[]) => void, excluded?: ReadonlySet<string>, maxWords = MAX_WORDS) {
  for (const tokens of fragments) for (let start = 0; start < tokens.length; start++) {
    if (isBoundaryStop(tokens[start]!.key, excluded)) continue;
    for (let size = 1; size <= maxWords && start + size <= tokens.length; size++) {
      const slice = tokens.slice(start, start + size);
      if (isBoundaryStop(slice[size - 1]!.key, excluded)) continue;
      visit(slice.map(token => token.key), slice);
    }
  }
}

/**
 * Who produced the content, with the same key the boilerplate stripper uses (mail sender, page host, else origin).
 * Only senders and hosts get a background contrast: an origin ("origin:obsidian") is a whole collection, and words
 * shared across a user's notes are its topics, not a template.
 */
export function sourceProducer(origin: string, uri: string, text: string): string {
  return boilerplateProducer({ origin, uri }, text);
}
const contrasted = (producer: string) => /^(?:email|host):/.test(producer);

const strippers = new WeakMap<Database, Map<string, { docs: number; strip: (text: string) => string }>>();

/** Drop the producer's boilerplate lines (footers, legal text, template constants) when the indexer has counted them. */
export function stripBoilerplate(db: Database, producer: string, text: string): string {
  try {
    const docs = db.query<{ docs: number }, [string]>('SELECT docs FROM search_boilerplate_producers WHERE producer=?').get(producer)?.docs ?? 0;
    if (docs < BOILERPLATE.minDocs && !producer.startsWith('email:')) return text;
    let byProducer = strippers.get(db);
    if (!byProducer) strippers.set(db, byProducer = new Map());
    let cached = byProducer.get(producer);
    if (!cached || cached.docs !== docs) {
      const stripper = boilerplateStripper(db, producer);
      if (byProducer.size > 2000) byProducer.clear();
      byProducer.set(producer, cached = { docs, strip: (input: string) => stripper(input).text });
    }
    return cached.strip(text);
  } catch { return text; } // no boilerplate tables (bare or scoped database)
}

export function ensureTermTables(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS search_phrases (phrase TEXT PRIMARY KEY, n INTEGER NOT NULL, df INTEGER NOT NULL,
      tf INTEGER NOT NULL, c_value REAL NOT NULL, g2 REAL NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS search_terms (term TEXT PRIMARY KEY, df INTEGER NOT NULL, tf INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS search_term_producers (producer TEXT NOT NULL, term TEXT NOT NULL, df INTEGER NOT NULL,
      PRIMARY KEY(producer,term)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS search_producers (producer TEXT PRIMARY KEY, documents INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS search_terms_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;`);
}

/** Corpus change stamp: any memory written, source added/removed/retitled changes it. */
function corpusStamp(db: Database): string {
  return db.query<{ stamp: string }, []>(`SELECT (SELECT count(*) FROM source_memories)||':'||coalesce((SELECT max(updated_at) FROM source_memories),0)
    ||':'||(SELECT count(*) FROM sources)||':'||coalesce((SELECT max(updated_at) FROM sources),0) AS stamp`).get()?.stamp ?? '';
}

function meta(db: Database, key: string): string | undefined {
  try { return db.query<{ value: string }, [string]>('SELECT value FROM search_terms_meta WHERE key=?').get(key)?.value; }
  catch { return undefined; }
}

interface Count { df: number; tf: number; last: number }

export interface PhraseBuild {
  documents: number; tokens: number; phrases: number; terms: number; producers: number; ms: number;
}

/** Strip boilerplate before counting; set by a retrieval module when one is available (kept optional on purpose). */
export type TextFilter = (sourceId: string, producer: string, text: string) => string;

/**
 * Rebuild the dictionary when the corpus changed since the stored watermark (or always with `force`); returns the
 * number of documents examined (0 when already current). `limit` caps the documents read, newest memories first.
 */
export function refreshPhraseDictionary(db: Database, options: { limit?: number; force?: boolean; filter?: TextFilter } = {}): number {
  ensureTermTables(db);
  const stamp = corpusStamp(db);
  if (!options.force && meta(db, 'watermark') === stamp) return 0;
  return buildPhraseDictionary(db, { ...options, stamp }).documents;
}

export function buildPhraseDictionary(db: Database, options: { limit?: number; filter?: TextFilter; stamp?: string } = {}): PhraseBuild {
  const started = performance.now();
  ensureTermTables(db);
  const stamp = options.stamp ?? corpusStamp(db);
  const limit = Math.max(1, options.limit ?? 100_000);
  const sources = db.query<{ id: string; origin: string; uri: string; title: string }, [number]>(`SELECT s.id,s.origin,s.uri,s.title FROM sources s
    LEFT JOIN source_memories m ON m.source_id=s.id ORDER BY coalesce(m.updated_at,s.updated_at) DESC, s.id LIMIT ?`).all(limit);
  const chunks = db.query<{ text: string }, [string]>(`SELECT text_content AS text FROM chunks WHERE source_id=? AND chunk_type='verbatim' ORDER BY chunk_index`);
  const counts = new Map<string, Count>();
  const producerDocs = new Map<string, number>();
  const producerTerms = new Map<string, Map<string, number>>();
  let documents = 0, tokens = 0;
  for (const source of sources) {
    const body = chunks.all(source.id).map(row => row.text).join('\n');
    const producer = sourceProducer(source.origin, source.uri, body);
    const kept = options.filter ? options.filter(source.id, producer, body) : stripBoilerplate(db, producer, body);
    const text = `${source.title.replace(/ · \d{4}-\d{2}-\d{2}$/, '')}\n${kept}`;
    const fragments = termFragments(text);
    if (!fragments.length) continue;
    documents++;
    const doc = documents;
    const seen: string[] = [];
    for (const fragment of fragments) tokens += fragment.length;
    eachCandidate(fragments, keys => {
      const key = keys.join(' ');
      let count = counts.get(key);
      if (!count) counts.set(key, count = { df: 0, tf: 0, last: 0 });
      count.tf++;
      if (count.last !== doc) { count.last = doc; count.df++; seen.push(key); }
    });
    if (!contrasted(producer)) continue;
    producerDocs.set(producer, (producerDocs.get(producer) ?? 0) + 1);
    let terms = producerTerms.get(producer);
    if (!terms) producerTerms.set(producer, terms = new Map());
    for (const key of seen) terms.set(key, (terms.get(key) ?? 0) + 1);
  }
  // Termhood over multiword candidates seen in at least two documents.
  const multi = [...counts.entries()].filter(([key, count]) => count.df >= 2 && key.includes(' '));
  const nested = new Map<string, { sum: number; types: number }>();
  for (const [key, count] of multi) {
    const words = key.split(' ');
    if (words.length < 3) continue;
    // Every bounded sub-phrase of length ≥ 2 nests inside this longer candidate.
    for (let start = 0; start < words.length; start++) for (let end = start + 2; end <= words.length; end++) {
      if (end - start === words.length || isBoundaryStop(words[start]!) || isBoundaryStop(words[end - 1]!)) continue;
      const sub = words.slice(start, end).join(' ');
      const entry = nested.get(sub) ?? { sum: 0, types: 0 };
      entry.sum += count.tf; entry.types++;
      nested.set(sub, entry);
    }
  }
  const tfOf = (key: string) => counts.get(key)?.tf ?? 0;
  const kept: Array<{ phrase: string; n: number; df: number; tf: number; cValue: number; g2: number }> = [];
  for (const [key, count] of multi) {
    const words = key.split(' ');
    const inner = nested.get(key);
    const cValue = Math.log2(words.length) * (inner ? count.tf - inner.sum / inner.types : count.tf);
    // Weakest split between bounded parts (stop words between them are the joint): a real term holds at every split.
    let strength = Infinity;
    for (let cut = 1; cut < words.length; cut++) {
      if (isBoundaryStop(words[cut - 1]!)) continue;
      let next = cut;
      while (next < words.length && isBoundaryStop(words[next]!)) next++;
      if (next >= words.length) continue;
      const left = tfOf(words.slice(0, cut).join(' ')), right = tfOf(words.slice(next).join(' '));
      const k11 = count.tf;
      strength = Math.min(strength, dunning(k11, Math.max(0, left - k11), Math.max(0, right - k11), Math.max(0, tokens - left - right + k11)));
    }
    if (!Number.isFinite(strength)) strength = 0;
    // Two copies of a long word run are usually one sender's template sentence, not a term.
    if ((words.length < 3 || count.df >= 3) && (cValue >= C_VALUE_MIN || strength >= G2_CRITICAL))
      kept.push({ phrase: key, n: words.length, df: count.df, tf: count.tf, cValue: Math.round(cValue * 100) / 100, g2: Math.round(strength * 100) / 100 });
  }
  const keptSet = new Set(kept.map(row => row.phrase));
  db.transaction(() => {
    db.run('DELETE FROM search_phrases'); db.run('DELETE FROM search_terms'); db.run('DELETE FROM search_term_producers'); db.run('DELETE FROM search_producers');
    const phrase = db.prepare('INSERT INTO search_phrases(phrase,n,df,tf,c_value,g2) VALUES(?,?,?,?,?,?)');
    for (const row of kept) phrase.run(row.phrase, row.n, row.df, row.tf, row.cValue, row.g2);
    const term = db.prepare('INSERT INTO search_terms(term,df,tf) VALUES(?,?,?)');
    for (const [key, count] of counts) if (!key.includes(' ')) term.run(key, count.df, count.tf);
    const producerRow = db.prepare('INSERT INTO search_producers(producer,documents) VALUES(?,?)');
    const producerTerm = db.prepare('INSERT INTO search_term_producers(producer,term,df) VALUES(?,?,?)');
    for (const [producer, docs] of producerDocs) {
      if (docs < PRODUCER_MIN_DOCS) continue;
      producerRow.run(producer, docs);
      // Only what recurs for this producer can be routine for it.
      for (const [key, df] of producerTerms.get(producer)!) if (df >= 2 && (!key.includes(' ') || keptSet.has(key))) producerTerm.run(producer, key, df);
    }
    const set = db.prepare('INSERT INTO search_terms_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    set.run('watermark', stamp); set.run('documents', String(documents)); set.run('tokens', String(tokens)); set.run('built_at', String(Date.now()));
  })();
  const build = { documents, tokens, phrases: kept.length, terms: [...counts.keys()].filter(key => !key.includes(' ')).length,
    producers: [...producerDocs.values()].filter(docs => docs >= PRODUCER_MIN_DOCS).length, ms: Math.round(performance.now() - started) };
  cache.delete(db); strippers.delete(db);
  return build;
}

interface Loaded {
  stamp: string; documents: number; avgLength: number;
  phrases: Map<string, { df: number; cValue: number; g2: number }>;
  terms: Map<string, number>;
  producers: Map<string, { documents: number; terms: Map<string, number> } | null>;
  dictionary: PhraseDictionary;
}

const cache = new WeakMap<Database, Loaded>();

function load(db: Database): Loaded {
  const stamp = `${meta(db, 'built_at') ?? ''}:${meta(db, 'documents') ?? ''}`;
  const cached = cache.get(db);
  if (cached && cached.stamp === stamp) return cached;
  const phrases = new Map<string, { df: number; cValue: number; g2: number }>();
  const terms = new Map<string, number>();
  let documents = 0, tokens = 0;
  try {
    documents = Number(meta(db, 'documents') ?? 0); tokens = Number(meta(db, 'tokens') ?? 0);
    for (const row of db.query<{ phrase: string; df: number; c_value: number; g2: number }, []>('SELECT phrase,df,c_value,g2 FROM search_phrases').all())
      phrases.set(row.phrase, { df: row.df, cValue: row.c_value, g2: row.g2 });
    for (const row of db.query<{ term: string; df: number }, []>('SELECT term,df FROM search_terms').all()) terms.set(row.term, row.df);
  } catch { documents = 0; phrases.clear(); terms.clear(); }
  const dictionary: PhraseDictionary = { documents, has: phrase => phrases.has(phrase.toLocaleLowerCase()), get: phrase => phrases.get(phrase.toLocaleLowerCase()) };
  const loaded: Loaded = { stamp, documents, avgLength: documents ? tokens / documents : 0, phrases, terms, producers: new Map(), dictionary };
  cache.set(db, loaded);
  return loaded;
}

/** The stored phrase dictionary, cached per process and reloaded when a rebuild changed it. */
export function loadPhraseDictionary(db: Database): PhraseDictionary {
  return load(db).dictionary;
}

/** Corpus document frequency of a unigram or phrase (0 when unknown), with the corpus size; for query weighting. */
export function termStatistics(db: Database): { documents: number; df: (term: string) => number } {
  const loaded = load(db);
  return { documents: loaded.documents, df: term => {
    const key = term.toLocaleLowerCase();
    return key.includes(' ') ? loaded.phrases.get(key)?.df ?? 0 : loaded.terms.get(key) ?? 0;
  } };
}

function producerStats(db: Database, loaded: Loaded, producer: string) {
  if (loaded.producers.has(producer)) return loaded.producers.get(producer)!;
  let stats: { documents: number; terms: Map<string, number> } | null = null;
  try {
    const row = db.query<{ documents: number }, [string]>('SELECT documents FROM search_producers WHERE producer=?').get(producer);
    if (row) stats = { documents: row.documents, terms: new Map(db.query<{ term: string; df: number }, [string]>(
      'SELECT term,df FROM search_term_producers WHERE producer=?').all(producer).map(item => [item.term, item.df])) };
  } catch { stats = null; }
  if (loaded.producers.size > 2000) loaded.producers.clear();
  loaded.producers.set(producer, stats);
  return stats;
}

const idf = (documents: number, df: number) => Math.log(1 + (documents - df + 0.5) / (df + 0.5));

/**
 * Phraseness of a multiword candidate: dictionary termhood (C-value and G², log-damped) or, for a phrase this
 * corpus has not seen twice, a weak prior only when the document itself repeats it. Unigrams are 1.
 */
function phraseness(entry: { cValue: number; g2: number } | undefined, n: number, tf: number, proper: boolean) {
  if (n === 1) return 1;
  if (entry) return (1 + 0.2 * Math.log2(1 + Math.max(0, entry.cValue) / C_VALUE_MIN) + 0.1 * Math.min(3, Math.log2(1 + entry.g2 / G2_CRITICAL))) * (n > 3 ? 0.85 : 1);
  // Unseen elsewhere: a name ("Alvin Loke") is still a unit; other one-document word runs mostly are not.
  return (tf >= 2 ? 0.7 : 0) + (proper ? 0.5 : 0);
}

/** Capitalised name-like run, but not a shouted sentence ("LIKELY RECEIVE THE POSITION"). */
function properRun(surface: string, keys: string[], excluded: ReadonlySet<string>) {
  const words = surface.split(' ').filter((_, index) => !isBoundaryStop(keys[index]!, excluded));
  const shouted = words.length > 2 && words.every(word => word === word.toUpperCase() && word.length > 5);
  return !shouted && words.every(word => /^\p{Lu}/u.test(word) || /\d/.test(word));
}

export interface SourceKeyphraseOptions {
  max?: number;
  /** Lower-case words never part of a keyphrase (e.g. participant names). */
  exclude?: Iterable<string>;
  /** Override the producer key (defaults to the stored source's sender or host). */
  producer?: string;
  /** Weight of the producer-background contrast in [0,1]: 0 ignores the sender, 1 removes what it always says. */
  contrast?: number;
  /** Strip the producer's boilerplate lines first (default true; idempotent on already-stripped text). */
  strip?: boolean;
  /** Skip the registry entity boost (no gazetteer). */
  entities?: boolean;
}

/** Top keyphrases characterising one source's retained text, scored against the corpus (and its sender). */
export function sourceKeyphrases(db: Database, sourceId: string, text: string, options: SourceKeyphraseOptions = {}): Keyphrase[] {
  const max = options.max ?? 8;
  const loaded = load(db);
  const excluded = new Set([...(options.exclude ?? [])].map(term => term.toLocaleLowerCase()));
  let producer = options.producer;
  if (producer === undefined) {
    try {
      // The stored transcript names the sender even when the caller passes cleaned text.
      const row = db.query<{ origin: string; uri: string; first: string | null }, [string]>(`SELECT origin,uri,(SELECT text_content FROM chunks
        WHERE source_id=s.id AND chunk_type='verbatim' ORDER BY chunk_index LIMIT 1) AS first FROM sources s WHERE id=?`).get(sourceId);
      producer = row ? sourceProducer(row.origin, row.uri, row.first ?? text) : '';
    } catch { producer = ''; }
  }
  const background = producer && contrasted(producer) ? producerStats(db, loaded, producer) : null;
  if (producer && options.strip !== false) text = stripBoilerplate(db, producer, text);
  let length = 0;
  const fragments = termFragments(text);
  if (!fragments.length) return [];
  for (const fragment of fragments) length += fragment.length;
  const candidates = new Map<string, { keys: string[]; tf: number; surfaces: Map<string, number> }>();
  eachCandidate(fragments, (keys, tokens) => {
    const key = keys.join(' ');
    const candidate = candidates.get(key) ?? { keys, tf: 0, surfaces: new Map() };
    candidate.tf++;
    const surface = tokens.map(token => token.raw).join(' ');
    candidate.surfaces.set(surface, (candidate.surfaces.get(surface) ?? 0) + 1);
    candidates.set(key, candidate);
  }, excluded);
  const entityKeys = new Set<string>();
  if (options.entities !== false) {
    try {
      for (const match of gazetteerFor(db).match(retainedText(text)))
        entityKeys.add((match.quote.match(TOKEN) ?? []).map(keyOf).join(' '));
    } catch { /* no registry (scoped or bare database) */ }
  }
  const N = Math.max(loaded.documents, 1), avg = loaded.avgLength || length;
  const k1 = 1.2, b = 0.75, contrastWeight = Math.min(1, Math.max(0, options.contrast ?? DEFAULT_CONTRAST));
  const scored = [...candidates.entries()].map(([key, candidate]) => {
    const n = candidate.keys.length;
    const entry = n > 1 ? loaded.phrases.get(key) : undefined;
    const entity = entityKeys.has(key);
    const phrase = [...candidate.surfaces.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]![0];
    let ph = phraseness(entry, n, candidate.tf, n > 1 && properRun(phrase, candidate.keys, excluded));
    if (entity && ph < 1) ph = 1;
    const words = candidate.keys.filter(word => !isBoundaryStop(word, excluded));
    // A phrase is rarer than its words by construction; scoring it by its own df alone would favour any long
    // one-off word run. Blend the phrase's idf with (mostly) its words' mean idf instead.
    const wordIdf = words.reduce((sum, word) => sum + idf(N, Math.max(0, (loaded.terms.get(word) ?? 0) - 1)), 0) / words.length;
    const ownIdf = idf(N, Math.max(0, (n === 1 ? loaded.terms.get(key) ?? 0 : entry?.df ?? 0) - 1));
    const tfPart = candidate.tf * (k1 + 1) / (candidate.tf + k1 * (1 - b + b * length / avg));
    let informativeness = tfPart * (n === 1 ? ownIdf : (ownIdf + 3 * wordIdf) / 4);
    if (background && background.documents >= PRODUCER_MIN_DOCS && contrastWeight > 0) {
      // Leave-one-out background probability of the term in this producer's documents; routine wording → ~0.
      const others = background.documents - 1;
      const contrast = (term: string) => {
        const q = (Math.max(0, (background.terms.get(term) ?? 0) - 1) + 0.5) / (others + 1);
        return 1 - contrastWeight + contrastWeight * Math.min(1, Math.max(0, -Math.log(q) / Math.log(others + 1)));
      };
      informativeness *= n === 1 || background.terms.has(key) ? contrast(key) : words.reduce((sum, word) => sum + contrast(word), 0) / words.length;
    }
    const score = ph * informativeness * (entity ? 1.5 : 1);
    return { key, phrase, n, score, stems: words.map(stem) };
  }).filter(item => item.score > 0 && !(item.n === 1 && VERBAL.test(item.phrase)))
    .sort((x, y) => y.score - x.score || x.key.localeCompare(y.key));
  const chosen: typeof scored = [];
  // Far below the best phrase is noise: a short notification has one or two topics, not eight.
  const floor = (scored[0]?.score ?? 0) * 0.1;
  for (const candidate of scored) {
    if (chosen.length >= max || candidate.score < floor) break;
    // Phrases sharing a content word ("sqlite", "sqlite migration") are one topic; keep the better-scored form.
    if (!chosen.some(other => candidate.stems.some(word => other.stems.includes(word)))) chosen.push(candidate);
  }
  return chosen.map(item => ({ phrase: item.phrase, score: Math.round(item.score * 1000) / 1000 }));
}
