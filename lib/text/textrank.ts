import { contentWords, sentences as splitSentences } from "./tokenize";

/** Sparse TF-IDF vector, L2-normalised so a dot product is the cosine. */
type Vector = Map<string, number>;

function tfidf(documents: string[][]): Vector[] {
  const df = new Map<string, number>();
  for (const terms of documents) for (const term of new Set(terms)) df.set(term, (df.get(term) ?? 0) + 1);
  return documents.map(terms => {
    const tf = new Map<string, number>();
    for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
    const vector: Vector = new Map();
    let norm = 0;
    for (const [term, count] of tf) {
      const weight = (1 + Math.log(count)) * Math.log(1 + documents.length / df.get(term)!);
      vector.set(term, weight); norm += weight * weight;
    }
    norm = Math.sqrt(norm);
    if (norm) for (const [term, weight] of vector) vector.set(term, weight / norm);
    return vector;
  });
}

export function cosine(a: Vector, b: Vector) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, weight] of small) dot += weight * (large.get(term) ?? 0);
  return dot;
}

/** Weighted PageRank by power iteration over a dense similarity matrix (rows need not be normalised). */
export function pagerank(weights: number[][], options: { damping?: number; iterations?: number; tolerance?: number } = {}): number[] {
  const n = weights.length;
  if (!n) return [];
  const damping = options.damping ?? 0.85, tolerance = options.tolerance ?? 1e-6;
  const outgoing = weights.map(row => row.reduce((sum, w) => sum + w, 0));
  let rank = new Array<number>(n).fill(1 / n);
  for (let iteration = 0; iteration < (options.iterations ?? 100); iteration++) {
    // Dangling nodes (no similar sentence) spread their rank uniformly instead of leaking it.
    const dangling = rank.reduce((sum, r, i) => sum + (outgoing[i] ? 0 : r), 0);
    const next = new Array<number>(n).fill((1 - damping) / n + damping * dangling / n);
    for (let i = 0; i < n; i++) {
      if (!outgoing[i]) continue;
      const share = damping * rank[i]! / outgoing[i]!;
      const row = weights[i]!;
      for (let j = 0; j < n; j++) if (row[j]) next[j]! += share * row[j]!;
    }
    const delta = next.reduce((sum, r, i) => sum + Math.abs(r - rank[i]!), 0);
    rank = next;
    if (delta < tolerance) break;
  }
  return rank;
}

export interface RankedSentence { text: string; index: number; score: number }

/**
 * LexRank-style extractive ranking: sentences are TF-IDF vectors, edges are cosine similarities above
 * `threshold`, and PageRank centrality orders them. Bounded by `maxSentences` (quadratic graph).
 */
export function rankSentences(input: string | string[], options: { threshold?: number; maxSentences?: number; minWords?: number } = {}): RankedSentence[] {
  const all = (typeof input === "string" ? splitSentences(input) : input).slice(0, options.maxSentences ?? 300);
  const candidates = all.map((text, index) => ({ text, index, terms: contentWords(text) }))
    .filter(sentence => sentence.terms.length >= (options.minWords ?? 3));
  if (!candidates.length) return [];
  const vectors = tfidf(candidates.map(sentence => sentence.terms));
  const threshold = options.threshold ?? 0.1;
  const weights = vectors.map((a, i) => vectors.map((b, j) => {
    if (i === j) return 0;
    const similarity = cosine(a, b);
    return similarity >= threshold ? similarity : 0;
  }));
  const rank = pagerank(weights);
  return candidates.map((sentence, i) => ({ text: sentence.text, index: sentence.index, score: rank[i]! }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

/**
 * Pick the most central sentences, skipping near-repeats of ones already chosen, and return them in
 * document order so the summary still reads chronologically.
 */
export function extractiveSummary(input: string | string[], options: { sentences?: number; maxChars?: number; redundancy?: number; maxSentences?: number } = {}): string[] {
  const ranked = rankSentences(input, { maxSentences: options.maxSentences });
  const limit = options.sentences ?? 3, maxChars = options.maxChars ?? 600, redundancy = options.redundancy ?? 0.6;
  const chosen: Array<RankedSentence & { vector: Vector }> = [];
  const vectors = tfidf(ranked.map(sentence => contentWords(sentence.text)));
  let length = 0;
  for (let i = 0; i < ranked.length && chosen.length < limit; i++) {
    const sentence = ranked[i]!, vector = vectors[i]!;
    if (chosen.some(other => cosine(other.vector, vector) >= redundancy)) continue;
    const text = sentence.text.length > 300 ? `${sentence.text.slice(0, 297).trimEnd()}…` : sentence.text;
    if (chosen.length && length + text.length > maxChars) continue;
    chosen.push({ ...sentence, text, vector }); length += text.length + 1;
  }
  return chosen.sort((a, b) => a.index - b.index).map(sentence => sentence.text);
}
