import { words } from './identity-keys';

/**
 * MinHash signatures with LSH banding over character 3-grams of names. Exact and acronym keys only meet
 * when names fold to the same string; this finds near-duplicates ("Redekop" / "Redekopp") in roughly
 * linear time, for the duplicate sweep to queue.
 */

/** Character n-grams of a folded name, padded so short names and word boundaries count. */
export function shingles(name: string, n = 3): Set<string> {
  const text = ` ${words(name).join(' ')} `;
  const grams = new Set<string>();
  if (text.trim().length === 0) return grams;
  for (let index = 0; index + n <= text.length; index++) grams.add(text.slice(index, index + n));
  return grams;
}

function fnv1a(text: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Final avalanche so seeds that differ in low bits give independent permutations.
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b) >>> 0; hash ^= hash >>> 13;
  return hash >>> 0;
}

export function signature(grams: Set<string>, size = 64): Uint32Array {
  const result = new Uint32Array(size).fill(0xffffffff);
  for (const gram of grams) for (let k = 0; k < size; k++) {
    const value = fnv1a(gram, k * 0x9e3779b1);
    if (value < result[k]!) result[k] = value;
  }
  return result;
}

/** Estimated Jaccard similarity of two signatures. */
export function estimate(a: Uint32Array, b: Uint32Array): number {
  let equal = 0;
  for (let k = 0; k < a.length; k++) if (a[k] === b[k]) equal++;
  return equal / a.length;
}

/**
 * Candidate pairs (a < b by position in `items`) that agree on every row of at least one band.
 * With 16 bands of 4 rows, pairs at Jaccard 0.6 are found with probability ≈ 0.88, at 0.4 ≈ 0.34.
 * Buckets larger than `maxBucket` are skipped: they are common fragments, not near-duplicates.
 */
export function lshPairs<T>(items: Array<{ key: T; signature: Uint32Array }>, bands = 16, rows = 4, maxBucket = 50): Array<[T, T]> {
  const pairs = new Map<string, [T, T]>();
  for (let band = 0; band < bands; band++) {
    const buckets = new Map<string, number[]>();
    items.forEach((item, index) => {
      const key = Array.from(item.signature.subarray(band * rows, band * rows + rows)).join(',');
      const bucket = buckets.get(key);
      if (bucket) bucket.push(index); else buckets.set(key, [index]);
    });
    for (const bucket of buckets.values()) {
      if (bucket.length < 2 || bucket.length > maxBucket) continue;
      for (let i = 0; i < bucket.length; i++) for (let j = i + 1; j < bucket.length; j++) {
        const id = `${bucket[i]},${bucket[j]}`;
        if (!pairs.has(id)) pairs.set(id, [items[bucket[i]!]!.key, items[bucket[j]!]!.key]);
      }
    }
  }
  return [...pairs.values()];
}
