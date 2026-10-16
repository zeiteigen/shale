import { STOP_WORDS, sentences as splitSentences } from "./tokenize";

/**
 * YAKE-style unsupervised keyphrase extraction (Campos et al., 2020): single-document statistics only —
 * casing, position, frequency, context dispersion, and sentence spread — so it needs no corpus or model.
 * Lower YAKE scores are better; the returned `score` is inverted to "higher is better" for callers.
 */
export interface Keyphrase { phrase: string; score: number; count: number }

interface TermStats { tf: number; upper: number; acronym: number; sentences: Set<number>; left: string[]; right: string[] }

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}'’_+#.-]*[\p{L}\p{N}+#]|[\p{L}\p{N}]/gu;
const NOISE = /https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+\.[\w.-]+|<[^>]*>|\[\d{1,2}:\d{2}\]/g;

/** Crude suffix stripping, only to treat "photo"/"photos" or "science"/"sciences" as one topic. */
const stem = (key: string) => key.length > 4 ? key.replace(/(?:ies|es|s|ing|ed)$/, "") : key;
/** Lower-case single words that read as verbs or adverbs ("looking", "continues") are rarely topics. */
const VERBAL = /^\p{Ll}+(?:ing|ed|ly)$/u;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export function extractKeyphrases(text: string, options: { max?: number; maxWords?: number; exclude?: Iterable<string>; window?: number; maxSentences?: number } = {}): Keyphrase[] {
  const max = options.max ?? 6, maxWords = options.maxWords ?? 3, window = options.window ?? 2;
  const excluded = new Set([...(options.exclude ?? [])].map(term => term.toLocaleLowerCase()));
  const sentences = splitSentences(text.replace(NOISE, " ")).slice(0, options.maxSentences ?? 2000);
  // Each sentence is split further at punctuation: a phrase never spans a comma or a colon.
  const runs: Array<{ sentence: number; tokens: Array<{ raw: string; key: string }> }> = [];
  const stats = new Map<string, TermStats>();
  const stop = (key: string) => STOP_WORDS.has(key) || excluded.has(key) || key.length < 2 || /^[\d.,:+#-]+$/.test(key);
  sentences.forEach((sentence, index) => {
    let first = true;
    for (const fragment of sentence.split(/[,;:()"“”!?|/\\[\]{}–—…]+|\s[-•*]\s/)) {
      const tokens = (fragment.match(TOKEN) ?? []).map(raw => ({ raw, key: raw.toLocaleLowerCase().replace(/['’]s$/, "") }));
      if (!tokens.length) continue;
      runs.push({ sentence: index, tokens });
      tokens.forEach((token, position) => {
        const term = stats.get(token.key) ?? { tf: 0, upper: 0, acronym: 0, sentences: new Set(), left: [], right: [] };
        term.tf++;
        term.sentences.add(index);
        if (/^\p{Lu}[\p{Lu}\p{N}]+$/u.test(token.raw)) term.acronym++;
        else if (/^\p{Lu}/u.test(token.raw) && !(first && position === 0)) term.upper++;
        if (!stop(token.key)) {
          for (let k = Math.max(0, position - window); k < position; k++) if (!stop(tokens[k]!.key)) term.left.push(tokens[k]!.key);
          for (let k = position + 1; k <= Math.min(tokens.length - 1, position + window); k++) if (!stop(tokens[k]!.key)) term.right.push(tokens[k]!.key);
        }
        stats.set(token.key, term);
      });
      first = false;
    }
  });
  const content = [...stats.entries()].filter(([key]) => !stop(key));
  if (!content.length) return [];
  const frequencies = content.map(([, term]) => term.tf);
  const mean = frequencies.reduce((a, b) => a + b, 0) / frequencies.length;
  const std = Math.sqrt(frequencies.reduce((sum, f) => sum + (f - mean) ** 2, 0) / frequencies.length);
  const maxTf = Math.max(...frequencies);
  const termScore = new Map<string, number>();
  for (const [key, term] of content) {
    const casing = Math.max(term.upper, term.acronym) / (1 + Math.log(term.tf));
    const position = Math.log(Math.log(3 + median([...term.sentences])));
    const frequency = term.tf / (mean + std || 1);
    const dispersion = (list: string[]) => list.length ? new Set(list).size / list.length : 0;
    const relatedness = 1 + (dispersion(term.left) + dispersion(term.right)) * (term.tf / maxTf);
    const spread = term.sentences.size / sentences.length;
    termScore.set(key, relatedness * position / (casing + frequency / relatedness + spread / relatedness));
  }
  const candidates = new Map<string, { keys: string[]; surfaces: Map<string, number>; count: number }>();
  for (const run of runs) {
    for (let start = 0; start < run.tokens.length; start++) {
      if (stop(run.tokens[start]!.key)) continue;
      for (let size = 1; size <= maxWords && start + size <= run.tokens.length; size++) {
        const slice = run.tokens.slice(start, start + size);
        if (stop(slice[size - 1]!.key)) continue;
        const key = slice.map(token => token.key).join(" ");
        const surface = slice.map(token => token.raw).join(" ");
        const candidate = candidates.get(key) ?? { keys: slice.map(token => token.key), surfaces: new Map(), count: 0 };
        candidate.count++;
        candidate.surfaces.set(surface, (candidate.surfaces.get(surface) ?? 0) + 1);
        candidates.set(key, candidate);
      }
    }
  }
  const scored = [...candidates.values()].map(candidate => {
    const scores = candidate.keys.filter(key => termScore.has(key)).map(key => termScore.get(key)!);
    const product = scores.reduce((a, b) => a * b, 1), sum = scores.reduce((a, b) => a + b, 0);
    // A one-off phrase is usually an accident of word order, not a topic, unless it is a proper noun.
    const proper = candidate.keys.every(key => { const term = stats.get(key)!; return stop(key) || term.upper + term.acronym > 0; });
    const yake = candidate.count < 2 && (candidate.keys.length > 1 || !proper) ? Infinity : product / (candidate.count * (1 + sum));
    const phrase = [...candidate.surfaces.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    return { phrase, keys: candidate.keys, stems: candidate.keys.filter(key => !stop(key)).map(stem), count: candidate.count, yake };
  }).filter(candidate => Number.isFinite(candidate.yake) && !(candidate.keys.length === 1 && VERBAL.test(candidate.phrase))).sort((a, b) => a.yake - b.yake || b.count - a.count || a.phrase.localeCompare(b.phrase));
  const chosen: typeof scored = [];
  for (const candidate of scored) {
    if (chosen.length >= max) break;
    // Phrases sharing a content word ("sqlite", "sqlite migration") are one topic; keep the better-scored form.
    const overlaps = chosen.some(other => candidate.stems.some(stem => other.stems.includes(stem)));
    if (!overlaps) chosen.push(candidate);
  }
  return chosen.map(candidate => ({ phrase: candidate.phrase, score: 1 / (1 + candidate.yake), count: candidate.count }));
}
