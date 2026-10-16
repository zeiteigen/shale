import { contentWords } from '../../lib/text/tokenize';

/**
 * The results page (stage S5): collapsing near-duplicates into one hit with `similar` ids, then MMR diversity.
 * Collapsing keys: the same email thread, the same P2 email template, the same SimHash cluster within a producer,
 * and the same normalised title. The representative is the best-scoring member (ties: the most recent), so the
 * "Nasser A. commented…" and "Missing I-20…" floods become one hit each, still reachable through `similar`.
 */

/** The connector's thread identity: everything before the window fragment. */
export const threadKey = (uri: string) => uri.match(/^email:\/\/inbox\/thread\/([^#/?]+)/)?.[1] ?? null;

/** Lower-cased title without reply/forward prefixes or punctuation; too-short titles say nothing. */
export function normaliseTitle(title: string): string | null {
  const text = title.normalize('NFKC').toLocaleLowerCase().replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return text.length >= 4 ? text : null;
}

/** The part of a title a person types: before the " · " subtitle or date. */
export const titleCore = (title: string) => title.split(' · ')[0]!.trim();

export interface CollapseItem { id: string; score: number; at: number | null; keys: readonly string[] }
export interface Collapsed<T extends CollapseItem> { item: T; similar: string[] }

/** Group items sharing any key (transitively); `items` need not be sorted. Groups come back best representative first. */
export function collapse<T extends CollapseItem>(items: readonly T[]): Array<Collapsed<T>> {
  const order = [...items].sort((a, b) => b.score - a.score || (b.at ?? 0) - (a.at ?? 0) || a.id.localeCompare(b.id));
  const parent = order.map((_, index) => index);
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]!));
  const owner = new Map<string, number>();
  order.forEach((item, index) => {
    for (const key of item.keys) {
      const other = owner.get(key);
      if (other === undefined) owner.set(key, index);
      else { const a = find(other), b = find(index); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
    }
  });
  const groups = new Map<number, Collapsed<T>>();
  order.forEach((item, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.similar.push(item.id);
    else groups.set(root, { item, similar: [] });
  });
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group);
}

/** Title words and linked entities, the two things two results can repeat. */
export interface Profile { title: Set<string>; entities: Set<number> }

export function profile(title: string, entities: Iterable<number>): Profile {
  return { title: new Set(contentWords(titleCore(title))), entities: new Set(entities) };
}

const jaccard = <T>(a: Set<T>, b: Set<T>) => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared++;
  return shared / (a.size + b.size - shared);
};

export const similarity = (a: Profile, b: Profile) => Math.max(jaccard(a.title, b.title), jaccard(a.entities, b.entities));

/**
 * Maximal marginal relevance (Carbonell & Goldstein) over the first `k` items: each next pick maximises
 * λ·relevance − (1−λ)·max similarity to the picks so far; relevance is the score rescaled to 0..1 within the top k.
 * Items after k keep their order.
 */
export function mmr<T>(items: readonly T[], scoreOf: (item: T) => number, profileOf: (item: T) => Profile, lambda = 0.7, k = 30): T[] {
  if (lambda >= 1 || items.length < 3) return [...items];
  const head = items.slice(0, k), tail = items.slice(k);
  const scores = head.map(scoreOf);
  const max = Math.max(...scores), min = Math.min(...scores), span = max - min || 1;
  const profiles = head.map(profileOf);
  const picked: number[] = [];
  const left = new Set(head.map((_, index) => index));
  const closest = new Array(head.length).fill(0);
  while (left.size) {
    let best = -1, bestValue = -Infinity;
    for (const index of left) {
      const value = lambda * (scores[index]! - min) / span - (1 - lambda) * closest[index]!;
      if (value > bestValue) { bestValue = value; best = index; }
    }
    picked.push(best);
    left.delete(best);
    for (const index of left) closest[index] = Math.max(closest[index]!, similarity(profiles[index]!, profiles[best]!));
  }
  return [...picked.map(index => head[index]!), ...tail];
}
