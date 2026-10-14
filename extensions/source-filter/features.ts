import type { FilterSource } from './types';

const METADATA = /^(?:subject|from|to|cc|bcc|date|sent|message[- ]id|title|url|domain|visits?|visit count|typed count|last visit|content origin|content observed at|extraction quality):\s*/i;
const FAILURE = /^(?:(?:error[:\s]*)?(?:404|403|500|502|503)(?:\s+(?:not found|forbidden|internal server error|bad gateway|service unavailable))?|page not found|not found|access denied|service unavailable|bad gateway|internal server error|please (?:sign|log) in(?: to continue)?|(?:sign|log) in(?: to continue)?|verify (?:that )?you(?: are|'re) human|checking your browser|just a moment\.?|complete the captcha|enable javascript(?: and cookies)?(?: to continue)?|this page (?:isn't|is not) available|temporarily unavailable)[.!]?$/i;
const CHROME = /^(?:home|menu|navigation|search|skip to (?:main )?content|next|previous|back|close|submit|continue|username|email(?: address)?|password|forgot (?:your )?password\??|remember me|sign up|register|privacy policy|terms(?: of (?:use|service))?|all rights reserved\.?|copyright(?: .*)?|accept (?:all )?cookies|reject (?:all )?cookies|cookie (?:policy|preferences|settings)|manage cookies|subscribe|unsubscribe|contact us|about us)[.!]?$/i;
const PROMOTIONS = [/\bbuy now\b/i, /\blimited[- ]time (?:offer|deal)\b/i, /\bact now\b/i,
  /\bclaim (?:your |a )?(?:prize|reward)\b/i, /\bguaranteed (?:income|returns?|profits?)\b/i,
  /\byou(?:'ve| have) won\b/i, /\bclick here to (?:claim|buy|win)\b/i, /\bexclusive (?:offer|deal)\b/i];

export interface SourceFeatures {
  text: string; lines: string[]; payloadLines: string[]; failureLines: string[];
  boilerplateRatio: number; repetitionRatio: number; linkRatio: number; urls: number;
  promotionCues: number; hasObservedText: boolean; fullyRetained: boolean;
}

/** Analyse observed excerpts once; never count the generated overview as another copy of the body. */
export function sourceFeatures(source: FilterSource): SourceFeatures {
  const excerpts = source.memory?.snippets.filter(snippet => snippet.kind === 'excerpt') ?? [];
  const observed = [...new Set(excerpts.map(snippet => snippet.text))].join('\n');
  const text = observed.split('\n').map(line => line.trim())
    .filter(line => line && !METADATA.test(line) && !/^— \d{4}-\d{2}-\d{2} —$/.test(line))
    .map(line => line.replace(/^\[\d{2}:\d{2}\]\s+[^\n]{1,120}?:\s*/, '')).join('\n');
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const failureLines = lines.filter(line => FAILURE.test(line));
  const boilerplate = lines.filter(line => CHROME.test(line) || FAILURE.test(line));
  const normalized = lines.map(line => line.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' '));
  const urls = text.match(/https?:\/\/[^\s<>]+/gi) ?? [];
  // Distributed excerpts can omit valuable content; a sampled shell is not a definite empty source.
  const retainedCharacters = excerpts.reduce((sum, snippet) => sum + snippet.text.length, 0);
  return { text, lines, payloadLines: lines.filter(line => !CHROME.test(line) && !FAILURE.test(line)), failureLines,
    boilerplateRatio: lines.length ? boilerplate.length / lines.length : 0,
    repetitionRatio: lines.length ? 1 - new Set(normalized).size / lines.length : 0,
    linkRatio: text.length ? urls.reduce((sum, url) => sum + url.length, 0) / text.length : 0,
    urls: urls.length, promotionCues: PROMOTIONS.filter(pattern => pattern.test(text)).length,
    hasObservedText: excerpts.length > 0,
    fullyRetained: !!source.memory && retainedCharacters >= source.memory.coverage.inputCharacters,
  };
}
