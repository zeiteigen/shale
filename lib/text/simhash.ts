import { fnv1a32, shingles, words } from "./tokenize";

/**
 * 64-bit SimHash (Charikar) over word shingles. Near-identical texts differ in few bits, so a Hamming
 * distance ≤ 3 marks a near-duplicate. Kept as two unsigned 32-bit halves to avoid BigInt in hot loops.
 */
export interface SimHash { hi: number; lo: number }

export function simhash(text: string, options: { shingle?: number; maxTokens?: number } = {}): SimHash | null {
  const tokens = words(text).slice(0, options.maxTokens ?? 20_000);
  const grams = shingles(tokens, options.shingle ?? 3);
  if (!grams.length) return null;
  const weights = new Float64Array(64);
  const counts = new Map<string, number>();
  for (const gram of grams) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  for (const [gram, count] of counts) {
    // Sub-linear weight: a repeated footer line must not dominate the fingerprint.
    const weight = 1 + Math.log(count);
    const halves = [fnv1a32(gram), fnv1a32(gram, 0x9e3779b1)];
    for (let half = 0; half < 2; half++) {
      const bits = halves[half]!;
      for (let bit = 0; bit < 32; bit++) weights[half * 32 + bit]! += (bits >>> bit) & 1 ? weight : -weight;
    }
  }
  let hi = 0, lo = 0;
  for (let bit = 0; bit < 32; bit++) {
    if (weights[bit]! > 0) hi |= 1 << bit;
    if (weights[32 + bit]! > 0) lo |= 1 << bit;
  }
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

function popcount(value: number) {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function hamming(a: SimHash, b: SimHash) {
  return popcount((a.hi ^ b.hi) >>> 0) + popcount((a.lo ^ b.lo) >>> 0);
}

/**
 * Four 16-bit bands. By pigeonhole, two hashes within Hamming distance 3 agree exactly on at least
 * one band, so an indexed equality lookup on the bands finds every candidate without a full scan.
 */
export function bands(hash: SimHash): [number, number, number, number] {
  return [hash.hi >>> 16, hash.hi & 0xffff, hash.lo >>> 16, hash.lo & 0xffff];
}

export const simhashHex = (hash: SimHash) => hash.hi.toString(16).padStart(8, "0") + hash.lo.toString(16).padStart(8, "0");
export const parseSimhash = (hex: string): SimHash => ({ hi: parseInt(hex.slice(0, 8), 16) >>> 0, lo: parseInt(hex.slice(8, 16), 16) >>> 0 });
