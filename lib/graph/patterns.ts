import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { canonicalPredicate, isSystemPredicate, PREDICATES } from './predicates';
import { gazetteerFor, registryNeighbours } from './gazetteer';

/**
 * Bootstrapped surface patterns (DIPRE / Snowball). The model's relation claims whose evidence quote names both
 * the subject and the object are seeds: the words between the two mentions (plus a word of context either side)
 * say how this corpus expresses the relation ("From: X <…> To: Y" is SENT_TO). Each seed context is generalised
 * into a few token patterns, and a pattern is kept only when it is supported by enough distinct seed pairs AND,
 * on held-out folds, rarely fires on a pair the model related differently. Applied to new text with the
 * gazetteer's entity spans, the surviving patterns propose typed claims whose quote is an exact substring, so
 * relations the corpus states the same way every time stop needing the model.
 */

export interface SurfacePattern {
  id: string;
  predicate: string;
  /** 'so': subject mention first; 'os': object first ("Y, posted by X"). */
  order: 'so' | 'os';
  /** Normalised tokens just before the first mention (may be empty). */
  left: string[];
  /** Tokens between the mentions; '*' matches one to four tokens. */
  middle: string[];
  right: string[];
  /** Distinct seed pairs that produced it. */
  support: number;
  /** Held-out precision and the labelled firings it was measured on. */
  precision: number;
  evaluated: number;
}

export interface PatternSeed {
  claimId: string;
  sourceId: string;
  revisionId: number;
  chunkIndex: number | null;
  predicate: string;
  subject: number;
  object: number;
  subjectType: string;
  objectType: string;
  text: string;
  subjectSpan: [number, number];
  objectSpan: [number, number];
  /** The passage around the quote (its chunk, or a window of it) and the quote's offset in it, for held-out firing. */
  context?: { text: string; offset: number };
}

export interface PatternToken { norm: string; start: number; end: number }

const URL = String.raw`https?:\/\/[^\s<>"')\]]+`;
const EMAIL = String.raw`[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}`;
const TOKEN = new RegExp(`${URL}|${EMAIL}|[\\p{L}\\p{M}\\p{N}&']+|[^\\s\\p{L}\\p{N}]`, 'gu');

/**
 * Word and punctuation tokens with offsets. Addresses and links collapse to <email>/<url> and digit runs to '#',
 * so "Order 1182 from X" and "Order 77 from Y" share a pattern.
 */
export function patternTokens(text: string): PatternToken[] {
  const tokens: PatternToken[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const raw = match[0];
    const norm = /^https?:/i.test(raw) ? '<url>' : raw.includes('@') && /\.\p{L}{2,}$/u.test(raw) ? '<email>'
      : raw.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\d+/g, '#');
    tokens.push({ norm, start: match.index!, end: match.index! + raw.length });
  }
  return tokens;
}

const WORD = /[\p{L}]/u;
const MAX_MIDDLE = 10;
const WILDCARD_MAX = 4;
const key = (pattern: Pick<SurfacePattern, 'predicate' | 'order' | 'left' | 'middle' | 'right'>) =>
  JSON.stringify([pattern.predicate, pattern.order, pattern.left, pattern.middle, pattern.right]);
const patternId = (k: string) => `pattern:${createHash('sha256').update(k).digest('hex').slice(0, 16)}`;

/** Token index range [first, last] covered by a character span, or null when it splits a token. */
function tokenRange(tokens: PatternToken[], span: [number, number]): [number, number] | null {
  const first = tokens.findIndex(token => token.start >= span[0] && token.start < span[1]);
  if (first < 0 || tokens[first]!.start !== span[0]) return null;
  let last = first;
  while (last + 1 < tokens.length && tokens[last + 1]!.end <= span[1]) last++;
  return tokens[last]!.end === span[1] ? [first, last] : null;
}

interface Context { order: 'so' | 'os'; left: string[]; middle: string[]; right: string[] }

/** The token context of two mention spans in one text, or null when they overlap or sit too far apart. */
export function contextOf(tokens: PatternToken[], subject: [number, number], object: [number, number], window = 2): Context | null {
  const s = tokenRange(tokens, subject), o = tokenRange(tokens, object);
  if (!s || !o || (s[0] <= o[1] && o[0] <= s[1])) return null;
  const [a, b] = s[0] < o[0] ? [s, o] : [o, s];
  const middle = tokens.slice(a[1] + 1, b[0]).map(token => token.norm);
  if (middle.length > MAX_MIDDLE) return null;
  return { order: s[0] < o[0] ? 'so' : 'os', middle,
    left: tokens.slice(Math.max(0, a[0] - window), a[0]).map(token => token.norm),
    right: tokens.slice(b[1] + 1, b[1] + 1 + window).map(token => token.norm) };
}

/**
 * Generalisations of one seed context, most specific first: the exact middle, the middle with one word of
 * context on either side, and (for longer middles) the first word(s) and last word with a wildcard between.
 * A middle with no word in it ("A, B", "A B") is too weak alone and must carry context.
 */
export function generalise(predicate: string, context: Context): Array<Pick<SurfacePattern, 'predicate' | 'order' | 'left' | 'middle' | 'right'>> {
  const { order, middle, left, right } = context;
  const out: Array<Pick<SurfacePattern, 'predicate' | 'order' | 'left' | 'middle' | 'right'>> = [];
  const add = (l: string[], m: string[], r: string[]) => {
    const words = [...m, ...l, ...r].filter(token => WORD.test(token) || token.startsWith('<'));
    if (!m.some(token => WORD.test(token) && token !== '*') && !words.length) return;
    if (!m.some(token => WORD.test(token)) && !l.length && !r.length) return;
    out.push({ predicate, order, left: l, middle: m, right: r });
  };
  add([], middle, []);
  if (left.length) add(left.slice(-1), middle, []);
  if (right.length) add([], middle, right.slice(0, 1));
  if (middle.length >= 3) add([], [middle[0]!, '*', middle.at(-1)!], []);
  if (middle.length >= 4) add([], [middle[0]!, middle[1]!, '*', middle.at(-1)!], []);
  return out;
}

/** Whether a middle token sequence matches a pattern middle with '*' gaps of one to four tokens. */
function matchMiddle(pattern: string[], tokens: string[], i = 0, j = 0): boolean {
  if (i === pattern.length) return j === tokens.length;
  if (pattern[i] === '*') {
    for (let gap = 1; gap <= WILDCARD_MAX && j + gap <= tokens.length; gap++) if (matchMiddle(pattern, tokens, i + 1, j + gap)) return true;
    return false;
  }
  return j < tokens.length && pattern[i] === tokens[j] && matchMiddle(pattern, tokens, i + 1, j + 1);
}

export function matches(pattern: Pick<SurfacePattern, 'order' | 'left' | 'middle' | 'right'>, context: Context) {
  if (pattern.order !== context.order || !matchMiddle(pattern.middle, context.middle)) return false;
  const left = context.left.slice(-pattern.left.length || context.left.length);
  if (pattern.left.length && left.join('\u0000') !== pattern.left.join('\u0000')) return false;
  if (pattern.right.length && context.right.slice(0, pattern.right.length).join('\u0000') !== pattern.right.join('\u0000')) return false;
  return true;
}

/** Whether a schema predicate accepts these entity types (exact schema name, domain and range checked). */
export function predicateFits(predicate: string, subjectType: string, objectType: string) {
  const mapped = canonicalPredicate(predicate, subjectType, objectType);
  return mapped.predicate === predicate && mapped.basis === 'schema';
}

const INVERSE = new Map<string, string>();
for (const definition of PREDICATES) if (definition.inverse) {
  INVERSE.set(definition.name, definition.inverse);
  if (!INVERSE.has(definition.inverse)) INVERSE.set(definition.inverse, definition.name);
}
const SYMMETRIC = new Set(PREDICATES.filter(definition => definition.symmetric).map(definition => definition.name));

/** Known relations between ordered entity pairs ("a>b" → predicates), with inverses and symmetric reads added. */
export type KnownRelations = Map<string, Set<string>>;
export function addKnown(known: KnownRelations, subject: number, predicate: string, object: number) {
  const put = (a: number, p: string, b: number) => {
    const k = `${a}>${b}`;
    const set = known.get(k) ?? new Set<string>();
    set.add(p); known.set(k, set);
  };
  put(subject, predicate, object);
  const inverse = SYMMETRIC.has(predicate) ? predicate : INVERSE.get(predicate);
  if (inverse) put(object, inverse, subject);
}

/** What the model extracted from one source: the entities it related and the relations it stated. */
export interface SourceRelations { entities: Set<number>; known: KnownRelations }

/**
 * 'positive' when the pair is known to hold the predicate; 'negative' when it holds only different relations, or
 * (local closed world) when the model read this source, related either entity to something, and did not say this.
 * The local rule underestimates precision where the model missed a relation, which is the safe direction.
 */
export function label(known: KnownRelations, subject: number, predicate: string, object: number, local?: SourceRelations): 'positive' | 'negative' | 'unknown' {
  const forward = known.get(`${subject}>${object}`), backward = known.get(`${object}>${subject}`);
  if (forward?.has(predicate)) return 'positive';
  const other = [...forward ?? [], ...backward ?? []].filter(p => p !== 'RELATED_TO');
  if (other.length) return 'negative';
  return local && (local.entities.has(subject) || local.entities.has(object)) ? 'negative' : 'unknown';
}

export interface LearnOptions {
  /** Distinct seed pairs a pattern needs. */
  minSupport?: number;
  /** Held-out precision a pattern needs. */
  minPrecision?: number;
  /** Labelled held-out firings a pattern needs before its precision is trusted. */
  minEvaluated?: number;
  folds?: number;
  /** Entity spans in a held-out passage beyond the seeds' own (the gazetteer), so patterns are tested on real text. */
  mentions?: (text: string) => Array<{ entityId: number; type: string; start: number; end: number }>;
  /** Per source, what the model extracted there (for the local closed-world label). */
  sourceRelations?: Map<string, SourceRelations>;
}

export interface LearnedPatterns {
  version: 1;
  learnedAt: number;
  seeds: number;
  candidates: number;
  patterns: SurfacePattern[];
  /** Held-out measurements of the kept patterns, pooled over folds. */
  heldOut: { firings: number; positives: number; negatives: number; seedRecall: number };
}

interface Mention { entity: number; type: string; span: [number, number] }
interface SeedText { key: string; fold: number; sourceId: string; text: string; tokens: PatternToken[]; mentions: Mention[] }

const foldOf = (sourceId: string, folds: number) => parseInt(createHash('sha256').update(sourceId).digest('hex').slice(0, 8), 16) % folds;

/**
 * Learn patterns from seeds. Folds are split by source, so a template repeated within one source never vouches
 * for itself. For each fold, patterns are generalised from the other folds' seed quotes and fired on every ordered
 * mention pair of the held-out fold's passages (the quote's whole chunk when known, with gazetteer mentions when
 * given): a pattern that also fires across a header ("<addr>: Subject: X") meets pairs it should not relate.
 * Firings are labelled by `label` and unlabelled firings do not count.
 */
export function learnPatterns(seeds: PatternSeed[], known: KnownRelations, options: LearnOptions = {}): LearnedPatterns {
  const minSupport = options.minSupport ?? 3, minPrecision = options.minPrecision ?? 0.9;
  const minEvaluated = options.minEvaluated ?? 5, folds = Math.max(2, options.folds ?? 3);
  // Passages with every mention the seeds (and the gazetteer) locate in them; a passage shared by several claims is one text.
  const texts = new Map<string, SeedText>();
  const seedContexts: Array<{ seed: PatternSeed; context: Context; fold: number }> = [];
  for (const seed of seeds) {
    const passage = seed.context ?? { text: seed.text, offset: 0 };
    const textKey = `${seed.revisionId}\u0000${passage.text}`;
    let entry = texts.get(textKey);
    if (!entry) {
      entry = { key: textKey, fold: foldOf(seed.sourceId, folds), sourceId: seed.sourceId, text: passage.text, tokens: patternTokens(passage.text),
        mentions: (options.mentions?.(passage.text) ?? []).map(match => ({ entity: match.entityId, type: match.type, span: [match.start, match.end] as [number, number] })) };
      texts.set(textKey, entry);
    }
    const shift = (span: [number, number]): [number, number] => [span[0] + passage.offset, span[1] + passage.offset];
    for (const mention of [{ entity: seed.subject, type: seed.subjectType, span: shift(seed.subjectSpan) }, { entity: seed.object, type: seed.objectType, span: shift(seed.objectSpan) }]) {
      // A seed span replaces a gazetteer span over the same text (the seed knows which entity is meant).
      entry.mentions = entry.mentions.filter(other => other.entity === mention.entity || other.span[1] <= mention.span[0] || other.span[0] >= mention.span[1]);
      if (!entry.mentions.some(other => other.entity === mention.entity && other.span[0] === mention.span[0])) entry.mentions.push(mention);
    }
    const context = contextOf(patternTokens(seed.text), seed.subjectSpan, seed.objectSpan);
    if (context) seedContexts.push({ seed, context, fold: entry.fold });
  }
  const pooled = new Map<string, { pattern: Pick<SurfacePattern, 'predicate' | 'order' | 'left' | 'middle' | 'right'>; support: Set<string>; positives: number; negatives: number; folds: number }>();
  let candidates = 0;
  for (let fold = 0; fold < folds; fold++) {
    const support = new Map<string, { pattern: ReturnType<typeof generalise>[number]; pairs: Set<string> }>();
    for (const { seed, context, fold: seedFold } of seedContexts) {
      if (seedFold === fold) continue;
      for (const pattern of generalise(seed.predicate, context)) {
        const k = key(pattern);
        const entry = support.get(k) ?? { pattern, pairs: new Set<string>() };
        entry.pairs.add(`${seed.subject}>${seed.object}`);
        support.set(k, entry);
      }
    }
    const trained = [...support.entries()].filter(([, entry]) => entry.pairs.size >= minSupport);
    candidates = Math.max(candidates, trained.length);
    for (const [k, { pattern, pairs }] of trained) {
      let positives = 0, negatives = 0;
      for (const text of texts.values()) {
        if (text.fold !== fold) continue;
        for (const a of text.mentions) for (const b of text.mentions) {
          if (a.entity === b.entity) continue;
          const context = contextOf(text.tokens, a.span, b.span);
          if (!context || !matches(pattern, context) || !predicateFits(pattern.predicate, a.type, b.type)) continue;
          const verdict = label(known, a.entity, pattern.predicate, b.entity, options.sourceRelations?.get(text.sourceId));
          if (verdict === 'positive') positives++; else if (verdict === 'negative') negatives++;
        }
      }
      const entry = pooled.get(k) ?? { pattern, support: new Set<string>(), positives: 0, negatives: 0, folds: 0 };
      for (const pair of pairs) entry.support.add(pair);
      entry.positives += positives; entry.negatives += negatives; entry.folds++;
      pooled.set(k, entry);
    }
  }
  const patterns: SurfacePattern[] = [];
  let firings = 0, positives = 0, negatives = 0;
  for (const [k, entry] of pooled) {
    const evaluated = entry.positives + entry.negatives;
    const precision = evaluated ? entry.positives / evaluated : 0;
    if (entry.support.size < minSupport || evaluated < minEvaluated || precision < minPrecision) continue;
    patterns.push({ id: patternId(k), ...entry.pattern, support: entry.support.size, precision: Math.round(precision * 1000) / 1000, evaluated });
    firings += evaluated; positives += entry.positives; negatives += entry.negatives;
  }
  patterns.sort((a, b) => b.precision - a.precision || b.support - a.support || a.id.localeCompare(b.id));
  // Seed recall: held-out seeds a kept pattern reproduces (each seed is held out in exactly one fold).
  let recalled = 0;
  for (const { seed, context } of seedContexts)
    if (patterns.some(pattern => pattern.predicate === seed.predicate && matches(pattern, context))) recalled++;
  return { version: 1, learnedAt: Date.now(), seeds: seedContexts.length, candidates, patterns,
    heldOut: { firings, positives, negatives, seedRecall: seedContexts.length ? Math.round(recalled / seedContexts.length * 1000) / 1000 : 0 } };
}

/** Surface names of each canonical entity: its names, its merged members' names, and its plain/search aliases. */
function surfaceNames(db: Database, ids: number[]): Map<number, string[]> {
  const names = new Map<number, string[]>();
  const query = db.query<{ name: string }, [number, number]>(`WITH RECURSIVE m(id) AS (SELECT ?1 UNION SELECT e.id FROM entities e JOIN m ON e.canonical_id=m.id)
    SELECT coalesce(display_name,name) AS name FROM entities WHERE id IN (SELECT id FROM m)
    UNION SELECT alias FROM graph_aliases WHERE entity_id IN (SELECT id FROM m) AND scope IN ('','search') LIMIT ?2`);
  for (const id of ids) names.set(id, [...new Set(query.all(id, 40).map(row => row.name.trim())
    .filter(name => name.length >= 2 && !/^entity:|^source:/.test(name)))].sort((a, b) => b.length - a.length));
  return names;
}

/** Character spans where a surface occurs as whole words (case-insensitive). */
function occurrences(text: string, surface: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const lower = text.toLowerCase(), needle = surface.toLowerCase();
  for (let index = lower.indexOf(needle); index >= 0 && out.length < 20; index = lower.indexOf(needle, index + 1)) {
    const before = text[index - 1], after = text[index + needle.length];
    if ((before && /[\p{L}\p{N}]/u.test(before)) || (after && /[\p{L}\p{N}]/u.test(after))) continue;
    out.push([index, index + needle.length]);
  }
  return out;
}

const PASSAGE = 4000;

const canonicalSQL = `WITH RECURSIVE up(id,root,depth) AS (SELECT id,id,0 FROM entities WHERE id=?
  UNION ALL SELECT up.id,e.canonical_id,depth+1 FROM up JOIN entities e ON e.id=up.root WHERE e.canonical_id IS NOT NULL AND depth<32)
  SELECT root FROM up ORDER BY depth DESC LIMIT 1`;

export function canonicalResolver(db: Database) {
  const cache = new Map<number, number>();
  const query = db.query<{ root: number }, [number]>(canonicalSQL);
  return (id: number) => {
    let value = cache.get(id);
    if (value === undefined) { value = query.get(id)?.root ?? id; cache.set(id, value); }
    return value;
  };
}

/**
 * Seeds from the model's typed relation claims: entity objects, not system predicates, mapped onto the schema
 * (RELATED_TO is not a relation worth a pattern), whose quote names both sides closest together.
 */
export function seedsFromDatabase(db: Database, options: { since?: number } = {}): { seeds: PatternSeed[]; known: KnownRelations; sourceRelations: Map<string, SourceRelations> } {
  const canonical = canonicalResolver(db);
  const rows = db.query<{ id: string; predicate: string; subject_id: number; object_id: number; st: string; ot: string; quote: string | null;
    revision_id: number | null; chunk_index: number | null; source_id: string | null; recorded_at: number }, []>(`
    SELECT c.id,c.predicate,c.subject_id,c.object_id,s.type AS st,o.type AS ot,ev.quote,ev.revision_id,ev.chunk_index,r.source_id,c.recorded_at
    FROM graph_claims c JOIN entities s ON s.id=c.subject_id JOIN entities o ON o.id=c.object_id
    LEFT JOIN graph_evidence ev ON ev.claim_id=c.id LEFT JOIN graph_source_revisions r ON r.id=ev.revision_id
    WHERE c.method='llm' AND c.status IN ('proposed','accepted') AND c.polarity=1 AND c.object_id IS NOT NULL`).all();
  const known: KnownRelations = new Map();
  const sourceRelations = new Map<string, SourceRelations>();
  const candidates: typeof rows = [];
  for (const row of rows) {
    if (isSystemPredicate(row.predicate)) continue;
    const predicate = canonicalPredicate(row.predicate, row.st, row.ot).predicate;
    if (predicate === 'RELATED_TO') continue;
    addKnown(known, canonical(row.subject_id), predicate, canonical(row.object_id));
    if (row.source_id) {
      const local = sourceRelations.get(row.source_id) ?? { entities: new Set<number>(), known: new Map() };
      local.entities.add(canonical(row.subject_id)); local.entities.add(canonical(row.object_id));
      addKnown(local.known, canonical(row.subject_id), predicate, canonical(row.object_id));
      sourceRelations.set(row.source_id, local);
    }
    if (row.quote && row.source_id && row.revision_id !== null && (options.since === undefined || row.recorded_at >= options.since))
      candidates.push({ ...row, predicate });
  }
  const names = surfaceNames(db, [...new Set(candidates.flatMap(row => [canonical(row.subject_id), canonical(row.object_id)]))]);
  const chunk = db.query<{ text_content: string }, [number, number]>('SELECT text_content FROM graph_revision_chunks WHERE revision_id=? AND chunk_index=?');
  const seeds: PatternSeed[] = [];
  const seen = new Set<string>();
  for (const row of candidates) {
    const subject = canonical(row.subject_id), object = canonical(row.object_id);
    if (subject === object) continue;
    const text = row.quote!;
    let best: { s: [number, number]; o: [number, number]; gap: number } | null = null;
    const sSpans = (names.get(subject) ?? []).flatMap(name => occurrences(text, name));
    const oSpans = (names.get(object) ?? []).flatMap(name => occurrences(text, name));
    for (const s of sSpans) for (const o of oSpans) {
      if (s[0] < o[1] && o[0] < s[1]) continue;
      const gap = Math.max(s[0], o[0]) - Math.min(s[1], o[1]);
      if (!best || gap < best.gap) best = { s, o, gap };
    }
    if (!best) continue;
    const dedupe = `${row.revision_id}:${subject}:${row.predicate}:${object}:${best.s[0]}:${best.o[0]}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    // The passage the quote came from: its chunk, or a window of a long one.
    let context: PatternSeed['context'];
    const passage = row.chunk_index === null ? null : chunk.get(row.revision_id!, row.chunk_index)?.text_content;
    const at = passage?.indexOf(text) ?? -1;
    if (passage && at >= 0) {
      const from = passage.length <= PASSAGE ? 0 : Math.max(0, at - PASSAGE / 4);
      context = { text: passage.slice(from, Math.max(from + PASSAGE, at + text.length + PASSAGE / 4)), offset: at - from };
    }
    seeds.push({ claimId: row.id, sourceId: row.source_id!, revisionId: row.revision_id!, chunkIndex: row.chunk_index, predicate: row.predicate,
      subject, object, subjectType: row.st, objectType: row.ot, text, subjectSpan: best.s, objectSpan: best.o, ...(context ? { context } : {}) });
  }
  return { seeds, known, sourceRelations };
}

export const PATTERN_STATE_KEY = 'relation-patterns-v1';

export function storedPatterns(db: Database, extensionId = 'knowledge-graph'): (LearnedPatterns & { seedClaims?: number }) | null {
  const row = db.query<{ value: string }, [string, string]>('SELECT value FROM extension_state WHERE extension_id=? AND state_key=?')
    .get(extensionId, PATTERN_STATE_KEY);
  if (!row) return null;
  try { const parsed = JSON.parse(row.value); return parsed?.version === 1 && Array.isArray(parsed.patterns) ? parsed : null; } catch { return null; }
}

/**
 * The stored patterns, relearned when missing or stale: older than `maxAgeMs` once `minNewClaims` model relation
 * claims have arrived since the last learning. Learning reads the whole claim table, so it runs at most daily.
 */
export function refreshPatterns(db: Database, options: LearnOptions & { maxAgeMs?: number; minNewClaims?: number; extensionId?: string } = {}) {
  const extensionId = options.extensionId ?? 'knowledge-graph';
  const stored = storedPatterns(db, extensionId);
  const claims = db.query<{ n: number }, []>("SELECT count(*) AS n FROM graph_claims WHERE method='llm' AND object_id IS NOT NULL AND status IN ('proposed','accepted')").get()!.n;
  const due = !stored || (Date.now() - stored.learnedAt >= (options.maxAgeMs ?? 86_400_000) && claims - (stored.seedClaims ?? 0) >= (options.minNewClaims ?? 50));
  if (!due) return { learned: stored!, relearned: false };
  const { seeds, known, sourceRelations } = seedsFromDatabase(db);
  const gazetteer = gazetteerFor(db);
  const learned = { ...learnPatterns(seeds, known, { sourceRelations, mentions: text => gazetteer.match(text, { neighbours: ids => registryNeighbours(db, ids) }), ...options }),
    seedClaims: claims };
  db.query(`INSERT INTO extension_state(extension_id,state_key,value,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(extension_id,state_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .run(extensionId, PATTERN_STATE_KEY, JSON.stringify(learned), Date.now());
  return { learned, relearned: true };
}

export interface PatternMention { entityId: number; type: string; start: number; end: number }

export interface PatternCandidate {
  subject: number;
  predicate: string;
  object: number;
  /** Exact substring of the text from the first mention's start to the second's end. */
  quote: string;
  start: number;
  end: number;
  patternId: string;
  confidence: number;
}

/**
 * Fire patterns on every ordered pair of mentions (gazetteer matches) within the context window. When several
 * patterns fire on one pair, the most precise wins; a pair that two predicates claim with equal confidence is
 * dropped rather than guessed. Domain and range are checked against the entities' types.
 */
export function applyPatterns(text: string, mentions: PatternMention[], patterns: SurfacePattern[]): PatternCandidate[] {
  if (!patterns.length || mentions.length < 2) return [];
  const tokens = patternTokens(text);
  const best = new Map<string, PatternCandidate[]>();
  for (const a of mentions) for (const b of mentions) {
    if (a.entityId === b.entityId) continue;
    const context = contextOf(tokens, [a.start, a.end], [b.start, b.end]);
    if (!context) continue;
    for (const pattern of patterns) {
      if (!matches(pattern, context) || !predicateFits(pattern.predicate, a.type, b.type)) continue;
      // Laplace-smoothed precision: a pattern measured on few firings is trusted less.
      const confidence = Math.round((pattern.precision * pattern.evaluated + 1) / (pattern.evaluated + 2) * 1000) / 1000;
      const start = Math.min(a.start, b.start), end = Math.max(a.end, b.end);
      const pair = `${Math.min(a.entityId, b.entityId)}:${Math.max(a.entityId, b.entityId)}`;
      const list = best.get(pair) ?? [];
      list.push({ subject: a.entityId, predicate: pattern.predicate, object: b.entityId, quote: text.slice(start, end), start, end, patternId: pattern.id, confidence });
      best.set(pair, list);
    }
  }
  const out: PatternCandidate[] = [];
  for (const list of best.values()) {
    list.sort((x, y) => y.confidence - x.confidence || (x.end - x.start) - (y.end - y.start));
    const top = list[0]!;
    const rival = list.find(other => other.predicate !== top.predicate && other.confidence === top.confidence);
    if (rival && !(INVERSE.get(rival.predicate) === top.predicate && rival.subject === top.object)) continue;
    out.push(top);
  }
  return out.sort((a, b) => a.start - b.start);
}
