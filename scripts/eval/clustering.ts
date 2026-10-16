/**
 * Clustering agreement between two hard assignments of items (source ids) to clusters (episode ids).
 * The reference fixes the item set: an item the candidate leaves out counts as its own singleton, so a
 * clusterer cannot score well by abstaining. Both metrics come from the contingency table, O(items).
 *   pairwise: precision/recall/F1 over unordered item pairs placed together;
 *   B-cubed:  per-item precision/recall of its cluster, averaged (Bagga & Baldwin), which does not
 *             let one huge cluster dominate the way pair counts do.
 */
export type Assignment = Map<string, string | number>;
export interface PRF { precision: number | null; recall: number | null; f1: number | null }
export interface ClusterAgreement { items: number; candidateCovered: number; pairwise: PRF & { truePairs: number; referencePairs: number; candidatePairs: number }; bcubed: PRF }

const pairs = (n: number) => n * (n - 1) / 2;
const f1 = (p: number | null, r: number | null) => p == null || r == null ? null : p + r ? 2 * p * r / (p + r) : 0;

function contingency(reference: Assignment, candidate: Assignment) {
  const MISSING = '\u0000singleton:';
  const cell = new Map<string, number>(), refSize = new Map<string, number>(), candSize = new Map<string, number>();
  const keys = new Map<string, [string, string, string]>();
  let covered = 0;
  for (const [item, ref] of reference) {
    const has = candidate.has(item); if (has) covered++;
    const a = `r${String(ref)}`, b = has ? `c${String(candidate.get(item))}` : MISSING + item, key = `${a}\u0001${b}`;
    cell.set(key, (cell.get(key) ?? 0) + 1);
    refSize.set(a, (refSize.get(a) ?? 0) + 1); candSize.set(b, (candSize.get(b) ?? 0) + 1);
    keys.set(item, [a, b, key]);
  }
  return { cell, refSize, candSize, keys, covered };
}

export function clusterAgreement(reference: Assignment, candidate: Assignment): ClusterAgreement {
  const { cell, refSize, candSize, keys, covered } = contingency(reference, candidate);
  let truePairs = 0, referencePairs = 0, candidatePairs = 0;
  for (const n of cell.values()) truePairs += pairs(n);
  for (const n of refSize.values()) referencePairs += pairs(n);
  for (const n of candSize.values()) candidatePairs += pairs(n);
  const pp = candidatePairs ? truePairs / candidatePairs : null, pr = referencePairs ? truePairs / referencePairs : null;
  let bp = 0, br = 0;
  for (const [a, b, key] of keys.values()) { const n = cell.get(key)!; bp += n / candSize.get(b)!; br += n / refSize.get(a)!; }
  const items = reference.size, bP = items ? bp / items : null, bR = items ? br / items : null;
  return { items, candidateCovered: covered,
    pairwise: { precision: pp, recall: pr, f1: f1(pp, pr), truePairs, referencePairs, candidatePairs },
    bcubed: { precision: bP, recall: bR, f1: f1(bP, bR) } };
}

/** Size profile of one assignment: how fragmented it is (79 of 82 episodes being singletons is the problem P4 targets). */
export function clusterStats(assignment: Assignment) {
  const sizes = new Map<string, number>();
  for (const cluster of assignment.values()) sizes.set(String(cluster), (sizes.get(String(cluster)) ?? 0) + 1);
  const values = [...sizes.values()].sort((a, b) => b - a);
  return { items: assignment.size, clusters: values.length, singletons: values.filter(n => n === 1).length,
    largest: values[0] ?? 0, median: values.length ? values[Math.floor(values.length / 2)]! : 0 };
}
