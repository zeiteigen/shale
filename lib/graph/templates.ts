import { createHash } from 'node:crypto';
import { tagTemporal } from './temporal';

/**
 * Template induction for bulk mail (RoadRunner-style wrapper induction). Mail from one sender with one subject
 * skeleton ("<name> commented in <name>", "<n> is your instagram code") is a template filled with values; aligning
 * a few instances separates the constant text from numbered slots, and every later instance is read by aligning it
 * against that wrapper: slot values come out with exact offsets, so extraction from them is grounded by construction.
 * A falling alignment score is the drift signal (the sender redesigned its mail): callers then fall back to the model.
 * Pure: no database, no model.
 */

/** One non-empty body line: trimmed text, its offset in the input, and its comparison key (links masked). */
export interface TemplateLine { text: string; start: number; key: string }

const HEADER = /^(?:from|to|cc|bcc|date|sent|reply-to)\s*:/i;
/** Quoted reply chains and signatures (the same cut sdk/chat/summarize.ts makes before reading mail). */
const REPLY_CHAIN = /\n(?:On .{5,200} wrote:|-- ?\n|_{10,}\s*\n\s*From:)/;
const LINK = /<?(?:https?:\/\/|www\.)[^\s<>]+>?/g;
const MAX_LINES = 400;
const MAX_LINE_CHARS = 1000;

export const lineKey = (line: string) => line.replace(LINK, '<url>').replace(/\s+/g, ' ').trim();

/**
 * The lines a template is made of: the subject line is kept (it is part of the template), the other header lines
 * (sender, recipient, date) and quoted replies are not. Offsets point into `text`.
 */
export function bodyLines(text: string, max = MAX_LINES): TemplateLine[] {
  const cut = REPLY_CHAIN.exec(text);
  const end = cut ? cut.index : text.length;
  const lines: TemplateLine[] = [];
  let position = 0, index = 0, header = true;
  while (position <= end && lines.length < max) {
    const newline = text.indexOf('\n', position);
    const stop = Math.min(newline < 0 ? text.length : newline, end);
    const raw = text.slice(position, stop);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed) header = false;
    // Header lines come first; a later "To: all students" is body text.
    else if (!(header && index < 8 && HEADER.test(trimmed)) && !trimmed.startsWith('>')) lines.push({ text: trimmed, start: position + lead, key: lineKey(trimmed) });
    index++;
    if (newline < 0 || newline >= end) break;
    position = newline + 1;
  }
  return lines;
}

/** The subject as written in the message text ("Subject: …" first line), or ''. */
export function messageSubject(text: string) {
  return /^\s*Subject:[ \t]*(.*)$/im.exec(text.slice(0, 2000))?.[1]?.trim() ?? '';
}

const NAME_RUN = /\b\p{Lu}[\p{L}'’.-]*(?:[ \t]+(?:(?:of|the|and|for|de|&)[ \t]+)?\p{Lu}[\p{L}'’.-]*)+/gu;

/**
 * A subject with its variable parts masked: links, addresses, dates, quoted strings, runs of capitalised words
 * (names: two or more words), and numbers. Single capitalised words stay: they are usually the template's own
 * wording ("Reminder:", "Welcome").
 */
export function subjectSkeleton(subject: string): string {
  let text = subject.normalize('NFKC').trim().replace(LINK, ' <url> ').replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, ' <email> ');
  for (const mention of tagTemporal(text).reverse()) text = `${text.slice(0, mention.offset)} <date> ${text.slice(mention.offset + mention.quote.length)}`;
  // Handles and identifiers ("sata_cable", "assessprep.leaked", "8ar__"): letters mixed with digits, dots, or underscores.
  text = text.replace(/\S+/g, token => {
    const core = token.replace(/[,.:;!?)]+$/, '');
    const handle = core.length > 1 && !/^\d+(?:st|nd|rd|th|s)$/i.test(core) && !core.startsWith('<')
      && (/_/.test(core) || /\p{L}\.\p{L}/u.test(core) || (/\d/.test(core) && /\p{L}/u.test(core)));
    return handle ? ` <id> ${token.slice(core.length)}` : token;
  });
  text = text.replace(/"[^"]{1,80}"|“[^”]{1,80}”|'[^']{2,80}'/g, ' <q> ').replace(NAME_RUN, ' <name> ').replace(/\d+(?:[.,:/]\d+)*/g, ' <n> ');
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

const skeletonTokens = (skeleton: string) => skeleton.split(/\s+|(?=[^\p{L}\p{N}<>'’-])|(?<=[^\p{L}\p{N}<>'’-])/u).filter(Boolean);

/** Skeletons of one sender that are the same template: similar token sets, or a shared opening ("<name> commented in"). */
export function similarSkeletons(a: string, b: string, minJaccard = 0.6) {
  if (a === b) return true;
  const x = skeletonTokens(a), y = skeletonTokens(b);
  const setX = new Set(x), setY = new Set(y);
  let shared = 0;
  for (const token of setX) if (setY.has(token)) shared++;
  if (shared / (setX.size + setY.size - shared || 1) >= minJaccard) return true;
  // A shared three-token opening that carries a masked value and a word: "<name> commented in", "ali , follow <name>".
  const head = x.slice(0, 3);
  return x.length >= 4 && y.length >= 4 && head.every((token, i) => token === y[i]) && head.some(token => token.startsWith('<'))
    && head.some(token => /\p{L}{3}/u.test(token) && !token.startsWith('<'));
}

export interface TemplateMessage { id: string; sender: string; subject: string; text: string; sentAt?: number }
export interface MessageCluster { id: string; sender: string; skeleton: string; members: TemplateMessage[] }

export const templateId = (sender: string, skeleton: string) =>
  `tpl:${createHash('sha256').update(`${sender}\u0000${skeleton}`).digest('hex').slice(0, 20)}`;

/**
 * Cluster messages by (sender address, subject skeleton), merging similar skeletons of the same sender. A sender's
 * remaining messages form one residual cluster (skeleton "*") when there are enough of them: promotions with
 * ever-new subjects share their header and footer, and that is what makes them recognisable as boilerplate.
 */
export function clusterMessages(messages: readonly TemplateMessage[], options: { minMembers?: number; minJaccard?: number } = {}): MessageCluster[] {
  const minMembers = options.minMembers ?? 5;
  const bySender = new Map<string, TemplateMessage[]>();
  for (const message of messages) {
    const sender = message.sender.trim().toLowerCase();
    if (!sender) continue;
    (bySender.get(sender) ?? bySender.set(sender, []).get(sender)!).push(message);
  }
  const clusters: MessageCluster[] = [];
  for (const [sender, list] of bySender) {
    if (list.length < minMembers) continue;
    const bySkeleton = new Map<string, TemplateMessage[]>();
    for (const message of list) {
      const skeleton = subjectSkeleton(message.subject);
      (bySkeleton.get(skeleton) ?? bySkeleton.set(skeleton, []).get(skeleton)!).push(message);
    }
    const skeletons = [...bySkeleton.keys()];
    const parent = skeletons.map((_, i) => i);
    const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]!));
    for (let i = 0; i < skeletons.length; i++) for (let j = i + 1; j < skeletons.length; j++)
      if (find(i) !== find(j) && similarSkeletons(skeletons[i]!, skeletons[j]!, options.minJaccard)) parent[find(j)] = find(i);
    const groups = new Map<number, string[]>();
    for (let i = 0; i < skeletons.length; i++) (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(skeletons[i]!);
    const residual: TemplateMessage[] = [];
    for (const group of groups.values()) {
      const members = group.flatMap(skeleton => bySkeleton.get(skeleton)!);
      if (members.length < minMembers) { residual.push(...members); continue; }
      // The group is named by its most common skeleton (ties: the shortest, then alphabetical), stable as members grow.
      const name = [...group].sort((a, b) => bySkeleton.get(b)!.length - bySkeleton.get(a)!.length || a.length - b.length || (a < b ? -1 : 1))[0]!;
      clusters.push({ id: templateId(sender, name), sender, skeleton: name, members: sortByTime(members) });
    }
    if (residual.length >= minMembers) clusters.push({ id: templateId(sender, '*'), sender, skeleton: '*', members: sortByTime(residual) });
  }
  return clusters.sort((a, b) => b.members.length - a.members.length || (a.id < b.id ? -1 : 1));
}

const sortByTime = (members: TemplateMessage[]) => [...members].sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0) || (a.id < b.id ? -1 : 1));

// ---------------------------------------------------------------------------------------------------------------
// Multiple alignment (center star over LCS) and wrappers

/** Index pairs of a longest common subsequence of two key sequences. */
export function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length, m = b.length;
  const table = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    table[i * (m + 1) + j] = a[i] === b[j] ? table[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(table[(i + 1) * (m + 1) + j]!, table[i * (m + 1) + j + 1]!);
  const pairs: Array<[number, number]> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (table[(i + 1) * (m + 1) + j]! >= table[i * (m + 1) + j + 1]!) i++;
    else j++;
  }
  return pairs;
}

interface Star {
  center: number;
  /** Center indices present in at least `theta` of the sequences, in order. */
  constant: number[];
  /** Per sequence: center index → that sequence's index, for the constants it contains. */
  positions: Array<Map<number, number>>;
}

/**
 * Center-star multiple alignment: the sequence closest (by total LCS) to all others is the center; a center element
 * aligned in at least `theta` of the sequences is constant. Constants are a subsequence of every sequence that
 * contains them, so gaps between consecutive constants are well defined in each.
 */
function centerStar(seqs: readonly string[][], theta: number): Star {
  const k = seqs.length;
  const pairs = new Map<string, Array<[number, number]>>();
  const total = new Array<number>(k).fill(0);
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) {
    const found = lcsPairs(seqs[i]!, seqs[j]!);
    pairs.set(`${i}:${j}`, found);
    total[i]! += found.length; total[j]! += found.length;
  }
  let center = 0;
  for (let i = 1; i < k; i++) if (total[i]! > total[center]!) center = i;
  const positions = seqs.map((_, s) => {
    if (s === center) return new Map(seqs[center]!.map((_, i) => [i, i]));
    const found = s < center ? pairs.get(`${s}:${center}`)!.map(([a, b]) => [b, a] as [number, number]) : pairs.get(`${center}:${s}`)!;
    return new Map(found);
  });
  const need = Math.max(2, Math.ceil(theta * k));
  const constant = seqs[center]!.map((_, i) => i).filter(i => positions.filter(map => map.has(i)).length >= need);
  return { center, constant, positions };
}

/** Per sequence, the elements between constant g-1 and constant g (g = 0 … constants), or null when unknown. */
function gapContents<T>(seqs: readonly T[][], star: Star, gap: number): Array<T[] | null> {
  return seqs.map((seq, s) => {
    const from = gap === 0 ? -1 : star.positions[s]!.get(star.constant[gap - 1]!);
    const to = gap === star.constant.length ? seq.length : star.positions[s]!.get(star.constant[gap]!);
    return from === undefined || to === undefined ? null : seq.slice(from + 1, to);
  });
}

export type WrapperPart = { tokens: string[] } | { slot: number };
export type WrapperItem =
  | { kind: 'const'; key: string }
  /** One line with constant token runs and slots ("{1} commented in {2}"). */
  | { kind: 'line'; parts: WrapperPart[] }
  /** Zero or more variable lines. */
  | { kind: 'gap'; slot: number };
export interface Wrapper { items: WrapperItem[]; slots: number; constChars: number; members: number }

// An initial keeps its period ("Harshal S."), so a name is one value rather than two slots around a constant ".".
const TOKEN = /<?(?:https?:\/\/|www\.)[^\s<>]+>?|\b\p{Lu}\.(?!\p{L})|[\p{L}\p{N}](?:[\p{L}\p{N}'’_.@-]*[\p{L}\p{N}])?|[^\s\p{L}\p{N}]/gu;
const tokenKey = (token: string) => /^<?(?:https?:\/\/|www\.)/.test(token) ? '<url>' : token;
const tokensOf = (line: string) => (line.match(TOKEN) ?? []).map(tokenKey);

/** Token-level alignment of one variable line across members: constant token runs and slots. */
function lineParts(lines: string[], theta: number, nextSlot: () => number): WrapperPart[] | null {
  const seqs = lines.map(tokensOf);
  if (seqs.some(seq => !seq.length)) return null;
  const star = centerStar(seqs, theta);
  if (star.constant.reduce((sum, i) => sum + seqs[star.center]![i]!.length, 0) < 3) return null;
  const parts: WrapperPart[] = [];
  for (let gap = 0; gap <= star.constant.length; gap++) {
    const contents = gapContents(seqs, star, gap);
    if (contents.some(content => content === null || content.length > 0)) parts.push({ slot: nextSlot() });
    if (gap === star.constant.length) break;
    const token = seqs[star.center]![star.constant[gap]!]!;
    const last = parts.at(-1);
    if (last && 'tokens' in last) last.tokens.push(token); else parts.push({ tokens: [token] });
  }
  return parts;
}

/**
 * Induce a wrapper from instances of one template: line-level center-star alignment, then token-level alignment
 * within single variable lines. Returns null for fewer than two instances or when nothing is constant.
 */
export function induceWrapper(texts: readonly string[], options: { theta?: number; maxSample?: number } = {}): Wrapper | null {
  const theta = options.theta ?? 0.7, maxSample = options.maxSample ?? 10;
  // An even spread over the (time-ordered) members, so one period's variant does not dominate.
  const step = Math.max(1, texts.length / maxSample);
  const sample = Array.from({ length: Math.min(maxSample, texts.length) }, (_, i) => texts[Math.floor(i * step)]!);
  if (sample.length < 2) return null;
  const docs = sample.map(text => bodyLines(text));
  const keys = docs.map(doc => doc.map(line => line.key));
  const star = centerStar(keys, theta);
  let slot = 0;
  const nextSlot = () => ++slot;
  const items: WrapperItem[] = [];
  for (let gap = 0; gap <= star.constant.length; gap++) {
    const contents = gapContents(docs, star, gap).filter((content): content is TemplateLine[] => content !== null);
    if (contents.some(content => content.length)) {
      // Every instance has the same few lines here: align them position by position, token by token.
      const width = contents[0]!.length;
      const parallel = contents.length >= 2 && width <= 8 && contents.every(content => content.length === width && content.every(line => line.text.length <= MAX_LINE_CHARS));
      if (!parallel) items.push({ kind: 'gap', slot: nextSlot() });
      else for (let position = 0; position < width; position++) {
        const parts = lineParts(contents.map(content => content[position]!.text), Math.max(theta, 0.8), nextSlot);
        if (parts && parts.some(part => 'slot' in part)) items.push({ kind: 'line', parts });
        else if (parts) items.push({ kind: 'const', key: contents[0]![position]!.key });
        else if (items.at(-1)?.kind !== 'gap') items.push({ kind: 'gap', slot: nextSlot() });
      }
    }
    if (gap < star.constant.length) items.push({ kind: 'const', key: keys[star.center]![star.constant[gap]!]! });
  }
  // Renumber slots in order of appearance (token-level numbering may have skipped).
  let number = 0;
  const renumber = new Map<number, number>();
  const fix = (id: number) => renumber.get(id) ?? (renumber.set(id, ++number), number);
  for (const item of items) {
    if (item.kind === 'gap') item.slot = fix(item.slot);
    else if (item.kind === 'line') for (const part of item.parts) if ('slot' in part) part.slot = fix(part.slot);
  }
  const constChars = items.reduce((sum, item) => sum + itemWeight(item), 0);
  if (!constChars) return null;
  return { items, slots: number, constChars, members: sample.length };
}

function itemWeight(item: WrapperItem) {
  return item.kind === 'const' ? item.key.length : item.kind === 'line'
    ? item.parts.reduce((sum, part) => sum + ('tokens' in part ? part.tokens.join('').length : 0), 0) : 0;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compiled = new WeakMap<WrapperItem, RegExp>();
/** A line item as an anchored regex; constant tokens may be separated by any whitespace, links match any link. */
function lineRegex(item: Extract<WrapperItem, { kind: 'line' }>) {
  let regex = compiled.get(item);
  if (regex) return regex;
  const source = item.parts.map((part, index) => {
    if ('slot' in part) return index === item.parts.length - 1 ? '\\s*(.+)' : '\\s*(.+?)';
    return `\\s*${part.tokens.map(token => token === '<url>' ? '<?(?:https?:\\/\\/|www\\.)[^\\s<>]+>?' : escape(token)).join('\\s*')}`;
  }).join('');
  regex = new RegExp(`^${source}\\s*$`, 'du');
  compiled.set(item, regex);
  return regex;
}

/** The wrapper as text with `{slot:N}` markers: constant lines, slot-bearing lines, and variable blocks. */
export function wrapperText(wrapper: Wrapper): string {
  return wrapper.items.map(item => item.kind === 'const' ? item.key : item.kind === 'gap' ? `{slot:${item.slot}} (variable lines)`
    : item.parts.map(part => 'slot' in part ? `{slot:${part.slot}}` : part.tokens.join(' ')).join(' ')).join('\n');
}

/** Constant wording only (no slot markers), for checking that a template-level entity is really in the template. */
export function constantText(wrapper: Wrapper): string {
  return wrapper.items.flatMap(item => item.kind === 'const' ? [item.key] : item.kind === 'line'
    ? item.parts.flatMap(part => 'tokens' in part ? [part.tokens.join(' ')] : []) : []).join('\n');
}

export interface SlotValue {
  slot: number;
  /** Exact substring of the input at [start, end). */
  value: string;
  start: number;
  end: number;
  /** Variable-line slots: how many lines the value spans. */
  lines?: number;
}
export interface WrapperMatch {
  /** matched constant characters / (all constant characters + unexplained characters), in [0, 1]. */
  score: number;
  slots: SlotValue[];
  /** Characters of input lines that neither matched a constant nor fell in a variable block. */
  unexplained: number;
  /** Characters of the input inside slots. */
  variableChars: number;
  bodyChars: number;
}

/**
 * Read an instance with a wrapper: dynamic-programming alignment of wrapper items against body lines that maximises
 * matched constant text, letting variable blocks absorb lines and charging lines nothing explains. Returns null when
 * the score falls below `minScore` (drift: the instance no longer follows the template).
 */
export function applyWrapper(wrapper: Wrapper, text: string, minScore = 0): WrapperMatch | null {
  const lines = bodyLines(text);
  const items = wrapper.items, m = items.length, n = lines.length, width = n + 1;
  const best = new Float64Array((m + 1) * width);
  const matchCache = new Map<number, RegExpExecArray | null>();
  const lineMatch = (i: number, j: number) => {
    const key = i * width + j;
    if (matchCache.has(key)) return matchCache.get(key)!;
    const item = items[i]!;
    const found = item.kind === 'line' && lines[j]!.text.length <= MAX_LINE_CHARS ? lineRegex(item).exec(lines[j]!.text) : null;
    matchCache.set(key, found);
    return found;
  };
  const matches = (i: number, j: number) => {
    const item = items[i]!;
    return item.kind === 'const' ? item.key === lines[j]!.key : item.kind === 'line' ? lineMatch(i, j) !== null : false;
  };
  const weights = items.map(itemWeight);
  for (let j = n - 1; j >= 0; j--) best[m * width + j] = best[m * width + j + 1]! - lines[j]!.key.length;
  for (let i = m - 1; i >= 0; i--) for (let j = n; j >= 0; j--) {
    const here = i * width + j;
    const skipItem = best[(i + 1) * width + j]!;
    if (j === n) { best[here] = skipItem; continue; }
    if (items[i]!.kind === 'gap') { best[here] = Math.max(best[here + 1]!, skipItem); continue; }
    let value = Math.max(skipItem, best[here + 1]! - lines[j]!.key.length);
    if (matches(i, j)) value = Math.max(value, weights[i]! + best[(i + 1) * width + j + 1]!);
    best[here] = value;
  }
  // Trace the alignment back out.
  let i = 0, j = 0, matched = 0, unexplained = 0;
  const slots: SlotValue[] = [];
  const gapLines = new Map<number, TemplateLine[]>();
  const close = 1e-9;
  while (i < m || j < n) {
    const here = i * width + j;
    if (i === m) { unexplained += lines[j]!.key.length; j++; continue; }
    const item = items[i]!;
    if (j === n) { i++; continue; }
    if (item.kind === 'gap') {
      if (Math.abs(best[here]! - best[here + 1]!) < close) { (gapLines.get(item.slot) ?? gapLines.set(item.slot, []).get(item.slot)!).push(lines[j]!); j++; }
      else i++;
      continue;
    }
    if (matches(i, j) && Math.abs(best[here]! - (weights[i]! + best[(i + 1) * width + j + 1]!)) < close) {
      matched += weights[i]!;
      if (item.kind === 'line') {
        const found = lineMatch(i, j)!, line = lines[j]!;
        let group = 1;
        for (const part of item.parts) {
          if (!('slot' in part)) continue;
          const [from, to] = found.indices![group++]!;
          const value = line.text.slice(from, to);
          if (value.trim()) slots.push({ slot: part.slot, value, start: line.start + from, end: line.start + to });
        }
      }
      i++; j++;
    } else if (Math.abs(best[here]! - best[(i + 1) * width + j]!) < close) i++;
    else { unexplained += lines[j]!.key.length; j++; }
  }
  for (const [slot, block] of gapLines) {
    const start = block[0]!.start, last = block.at(-1)!;
    slots.push({ slot, value: text.slice(start, last.start + last.text.length), start, end: last.start + last.text.length, lines: block.length });
  }
  slots.sort((a, b) => a.start - b.start);
  const score = matched / (wrapper.constChars + unexplained || 1);
  if (score < minScore) return null;
  const bodyChars = lines.reduce((sum, line) => sum + line.text.length, 0);
  return { score, slots, unexplained, variableChars: slots.reduce((sum, slot) => sum + slot.value.length, 0), bodyChars };
}

/** A stable fingerprint of a wrapper's structure: slot labels stay valid exactly while it is unchanged. */
export const wrapperHash = (wrapper: Wrapper) =>
  createHash('sha256').update(JSON.stringify(wrapper.items)).digest('hex').slice(0, 16);
