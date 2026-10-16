import { eng } from "stopword";

/** Shared, dependency-free text primitives for the extractive and distilled components. */
export const STOP_WORDS: ReadonlySet<string> = new Set([...eng, "not", "also", "just", "like", "get", "got", "one", "will", "can", "us"]);

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;

/** Lower-cased word tokens (letters/digits, inner apostrophes and hyphens kept). */
export function words(text: string): string[] {
  return (text.normalize("NFKC").toLocaleLowerCase().match(WORD) ?? []).map(word => word.replace(/['’]s$/, ""));
}

export const isStopWord = (word: string) => STOP_WORDS.has(word.toLocaleLowerCase());

/** Content words: no stop words, no bare numbers, at least two characters. */
export function contentWords(text: string): string[] {
  return words(text).filter(word => word.length > 1 && !STOP_WORDS.has(word) && !/^\d+$/.test(word));
}

const ABBREVIATION = /\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|inc|ltd|co|no|fig|approx)\.$/i;

/**
 * Split prose into sentences. Newlines end sentences too (chat transcripts and emails are line-oriented);
 * abbreviations and decimals do not.
 */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    let buffer = "";
    for (const part of line.split(/(?<=[.!?…])\s+(?=["'“(\[]?[\p{Lu}\p{N}])/u)) {
      buffer = buffer ? `${buffer} ${part}` : part;
      if (!ABBREVIATION.test(buffer.trim())) { out.push(buffer.trim()); buffer = ""; }
    }
    if (buffer.trim()) out.push(buffer.trim());
  }
  return out.filter(sentence => /[\p{L}\p{N}]/u.test(sentence));
}

/** Contiguous word n-grams ("shingles") used for near-duplicate fingerprints. */
export function shingles(tokens: readonly string[], size = 3): string[] {
  if (tokens.length <= size) return tokens.length ? [tokens.join(" ")] : [];
  const out: string[] = [];
  for (let i = 0; i + size <= tokens.length; i++) out.push(tokens.slice(i, i + size).join(" "));
  return out;
}

/** 32-bit FNV-1a; deterministic and cheap, used for feature hashing and fingerprints. */
export function fnv1a32(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
