/**
 * Ranking features of the search engine (stage S4), each normalised to 0..1, and the linear scoring over them.
 * The engine (sdk/retrieval/engine.ts) computes the values; this module owns their names, default weights, and the
 * passage-level text features (proximity, best passage), which are pure functions of chunk text.
 */

export const FEATURES = ['bm25f', 'coverage', 'proximity', 'phrase', 'title', 'entity', 'graph', 'recency', 'upcoming', 'involvement', 'quality', 'bulk'] as const;
export type Feature = typeof FEATURES[number];
export type FeatureVector = Record<Feature, number>;
export type SearchWeights = Record<Feature, number>;

/**
 * Hand-set weights, then tuned by coordinate ascent (scripts/search-tune.ts) and kept only when the held-out half of
 * the judged queries improved. Quality and bulk are penalties (1 = boilerplate, filtered, or metadata-only; a large
 * cluster of near-identical results), hence negative. `upcoming` is non-zero only for deadline wording; too few
 * evaluation queries carry it to tune it, so it stays hand-set (FIXED_FEATURES).
 */
export const DEFAULT_SEARCH_WEIGHTS: SearchWeights = {
  // Tuned (scripts/search-tune.ts, fold 0: 1104 known-item + 21 judged training queries) from hand-set starting weights
  // { bm25f 1, coverage 1.2, proximity 0.3, phrase 0.4, title 0.6, entity 0.5, graph 0.25, recency 0.15, involvement 0.1,
  // quality -0.6, bulk -0.1 }; held-out judged nDCG@5 0.758 → 0.782, held-out known-item 0.760 → 0.770 (the other
  // fold also improved on its held-out half). Entity match carries no weight of its own: linked entities already
  // reach the score through their names in the `entities` field (BM25F, coverage) and through graph proximity.
  bm25f: 1.056, coverage: 2.268, proximity: 0.238, phrase: 0.01, title: 0.864, entity: 0, graph: 0.171, recency: 0.137, upcoming: 1.5,
  involvement: 0.096, quality: -0.288, bulk: -0.072,
};
export const FIXED_FEATURES: ReadonlySet<Feature> = new Set(['upcoming']);

export const zeroFeatures = (): FeatureVector => Object.fromEntries(FEATURES.map(feature => [feature, 0])) as FeatureVector;

export function score(features: FeatureVector, weights: SearchWeights): number {
  let total = 0;
  for (const feature of FEATURES) total += (weights[feature] ?? 0) * (features[feature] ?? 0);
  return total;
}

/** Merge weight overrides (unknown names and non-finite values ignored). */
export function mergeWeights(base: SearchWeights, ...overrides: Array<Partial<Record<string, unknown>> | null | undefined>): SearchWeights {
  const out = { ...base };
  for (const override of overrides) if (override && typeof override === 'object')
    for (const feature of FEATURES) { const value = override[feature]; if (typeof value === 'number' && Number.isFinite(value)) out[feature] = value; }
  return out;
}

// ---------------------------------------------------------------- recency and involvement

const DAY = 86_400_000;

/** Half-life of a source's relevance by kind: mail and chat age fast, notes and documents slowly. */
export function halfLifeDays(type: string, origin: string): number {
  if (origin === 'email' || type === 'email') return 60;
  if (type === 'chat_session') return 90;
  if (type === 'markdown_note' || type === 'document' || type === 'image') return 365;
  return 120;
}

export function recency(at: number | null, now: number, halfLife: number): number {
  if (at === null || !Number.isFinite(at)) return 0;
  if (at >= now) return 1;
  return Math.pow(0.5, (now - at) / (halfLife * DAY));
}

/** Upcoming (deadline intent): the nearer a future date, the better; a passed date counts a little, if recent. */
export function upcoming(dates: number[], now: number): number {
  let best = 0;
  for (const date of dates) best = Math.max(best, date >= now ? Math.exp(-(date - now) / (45 * DAY)) : 0.3 * Math.pow(0.5, (now - date) / (14 * DAY)));
  return best;
}

export const INVOLVEMENT: Record<string, number> = { author: 1, participant: 0.75, observer: 0.35, none: 0.1 };

// ---------------------------------------------------------------- passages

/** Crude suffix folding so "deadlines"/"deadline" and "computing"/"compute" meet (the index itself uses porter). */
export function stemWord(word: string): string {
  let value = word.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/['’]s$/, '');
  for (const suffix of ['ational', 'ations', 'ation', 'ings', 'ing', 'edly', 'ies', 'ed', 'es', 'ly', 's', 'e']) {
    if (value.length - suffix.length >= 4 && value.endsWith(suffix)) { value = value.slice(0, -suffix.length); break; }
  }
  return value;
}

const WORD = /[\p{L}\p{N}]+/gu;

export interface Passage { chunkIndex: number; matched: number; window: number }

/**
 * The best passage of a source for the query: the chunk covering the most distinct query terms within the smallest
 * window (Tao & Zhai's minimum span), preferring a snippet over the summary when it covers as many terms, since the
 * summary paraphrases and the snippet is what can be cited. `terms` holds, per query term, its accepted stems.
 */
export function bestPassage(chunks: Array<{ chunkIndex: number; text: string }>, terms: string[][]): Passage | null {
  let best: Passage | null = null;
  // Only words sharing a stem's first three letters are stemmed (most words of a chunk are not query words).
  const prefixes = new Set(terms.flat().map(stem => stem.slice(0, 3)));
  for (const chunk of chunks) {
    const positions: Array<{ at: number; term: number }> = [];
    let index = 0;
    for (const match of chunk.text.toLocaleLowerCase().matchAll(WORD)) {
      if (prefixes.has(match[0].slice(0, 3)) || /[^\x00-\x7f]/.test(match[0])) {
        const stem = stemWord(match[0]);
        for (let term = 0; term < terms.length; term++) if (terms[term]!.includes(stem)) positions.push({ at: index, term });
      }
      index++;
    }
    if (!positions.length) continue;
    const window = minimalWindow(positions, terms.length);
    const candidate = { chunkIndex: chunk.chunkIndex, matched: window.matched, window: window.width };
    if (!best || candidate.matched > best.matched
      || (candidate.matched === best.matched && (best.chunkIndex === 0 && candidate.chunkIndex > 0
        || ((candidate.chunkIndex > 0) === (best.chunkIndex > 0) && candidate.window < best.window)))) best = candidate;
  }
  return best;
}

/** Smallest span of positions containing the largest number of distinct terms (sliding window over sorted hits). */
export function minimalWindow(positions: Array<{ at: number; term: number }>, termCount: number): { matched: number; width: number } {
  const distinct = new Set(positions.map(position => position.term)).size;
  const counts = new Array(termCount).fill(0);
  let covered = 0, left = 0, width = Infinity;
  for (let right = 0; right < positions.length; right++) {
    if (counts[positions[right]!.term]++ === 0) covered++;
    while (covered === distinct) {
      width = Math.min(width, positions[right]!.at - positions[left]!.at + 1);
      if (--counts[positions[left]!.term] === 0) covered--;
      left++;
    }
  }
  return { matched: distinct, width: Number.isFinite(width) ? width : 1 };
}

/** Proximity in 0..1: share of query terms in the passage, discounted by how spread out they are. */
export function proximity(passage: Passage | null, termCount: number): number {
  if (!passage || !termCount) return 0;
  const share = passage.matched / termCount;
  if (passage.matched < 2) return termCount === 1 ? share : share * 0.25;
  return share * Math.min(1, (passage.matched + 1) / passage.window);
}
