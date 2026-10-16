/**
 * TIMEX3-style rule tagger: finds dates, times, relative expressions, deadlines, and ranges in free text and
 * normalises them to epoch intervals, keeping the exact quoted span. Pure and deterministic, so the extractor can
 * both produce dated claims without a model and check a model's timestamps against what a quote actually says.
 *
 * Normalisation follows the extractor's existing ISO rule: a calendar date is UTC midnight of the date as written
 * (no timezone shift), a stated time with a zone is converted to UTC, and a time without a zone is read as UTC
 * unless `defaultOffsetMinutes` says otherwise. Year- and month-only expressions keep their coarse grain and never
 * yield day timestamps. Relative expressions ("tomorrow", "next Friday") and yearless dates need an anchor.
 */
export type TemporalGrain = 'year' | 'month' | 'day' | 'minute';
export type TemporalKind = 'date' | 'deadline' | 'range';

export interface TemporalMention {
  /** Interval start (epoch ms). */
  start: number;
  /** Exclusive end for a single point; the second point's start for a range. */
  end: number;
  /** Exact substring of the input, starting at `offset`. */
  quote: string;
  offset: number;
  grain: TemporalGrain;
  kind: TemporalKind;
  /** UTC midnight of every calendar day the expression writes out (day and minute grain only). */
  days: number[];
  /** Point values a timestamp may take while staying faithful to the quote: the starts of its endpoints. */
  values: number[];
  /** A time without a stated zone, read at `defaultOffsetMinutes`. */
  floating?: boolean;
  relative?: boolean;
}

export interface TagOptions {
  /** Reference time for relative and yearless expressions (usually the source's creation time). */
  anchor?: number;
  /** Reading of ambiguous numeric dates such as 03/04/2026. */
  dateOrder?: 'mdy' | 'dmy';
  /** Offset applied to times that state no zone (minutes east of UTC). */
  defaultOffsetMinutes?: number;
}

const DAY = 86_400_000, MINUTE = 60_000;
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const WEEKDAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTH = String.raw`(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?`;
const WEEKDAY = String.raw`(?:Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\.?`;
const ORDINAL = String.raw`(\d{1,2})(?:st|nd|rd|th)?`;
/** Zone abbreviations seen in mail and event pages; ambiguous generic zones (ET, PT) follow US daylight saving. */
const ZONES: Record<string, number | 'us-eastern' | 'us-central' | 'us-mountain' | 'us-pacific'> = {
  UTC: 0, GMT: 0, Z: 0, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420,
  ET: 'us-eastern', CT: 'us-central', MT: 'us-mountain', PT: 'us-pacific', BST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180,
  IST: 330, JST: 540, KST: 540, SGT: 480, HKT: 480, AEST: 600, AEDT: 660, NZST: 720, NZDT: 780,
};
const ZONE = String.raw`(?:\(?\s*((?:UTC|GMT)\s*[+\-−]\s*\d{1,2}(?::?\d{2})?|UTC|GMT|[ECMP][SD]T|[ECMP]T|BST|CEST|CET|EEST|EET|IST|JST|KST|SGT|HKT|AEST|AEDT|NZST|NZDT)\b\s*\)?)`;
const SMALL_NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, thirty: 30 };
/** Words before a date that make it a deadline. */
const DEADLINE_CUE = /\b(?:by|due|deadlines?|ends?|ending|closes?|closing|close[sd]?|until|till|before|no later than|expires?|expiring|expiry|last day|submit(?:ted)?|apply)\b[^.!?\n]{0,32}$/i;

interface DateAtom { offset: number; end: number; y?: number; m: number; d?: number; grain: 'day' | 'month' | 'year'; relative?: boolean; dayValue?: number }
interface TimeAtom { offset: number; end: number; h: number; min: number; zone?: string; meridiem: boolean }

const monthOf = (name: string) => MONTHS[name.toLowerCase().replace(/\.$/, '').slice(0, name.toLowerCase().startsWith('sept') ? 4 : 3)];
/** Month and weekday names count only when capitalised: "may", "march", and "sun" are ordinary words. */
const capitalised = (word: string) => /^\p{Lu}/u.test(word);

function utcDay(y: number, m: number, d: number) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const value = Date.UTC(y, m - 1, d);
  const check = new Date(value);
  return check.getUTCMonth() === m - 1 && check.getUTCDate() === d ? value : null;
}

/** US daylight saving: second Sunday in March to first Sunday in November. */
function usDaylight(dayValue: number) {
  const date = new Date(dayValue), y = date.getUTCFullYear();
  const nthSunday = (month: number, n: number) => {
    const first = new Date(Date.UTC(y, month, 1)).getUTCDay();
    return Date.UTC(y, month, 1 + ((7 - first) % 7) + 7 * (n - 1));
  };
  return dayValue >= nthSunday(2, 2) && dayValue < nthSunday(10, 1);
}

function zoneOffset(zone: string, dayValue: number): number | null {
  const clean = zone.replace(/[()\s]/g, '').toUpperCase().replace('−', '-');
  const numeric = /^(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(clean);
  if (numeric) return (numeric[1] === '-' ? -1 : 1) * (Number(numeric[2]) * 60 + Number(numeric[3] ?? 0));
  const known = ZONES[clean];
  if (known === undefined) return null;
  if (typeof known === 'number') return known;
  const standard = { 'us-eastern': -300, 'us-central': -360, 'us-mountain': -420, 'us-pacific': -480 }[known];
  return standard + (usDaylight(dayValue) ? 60 : 0);
}

/** Yearless dates take the year that puts them closest to the anchor. */
function inferYear(m: number, d: number, anchor: number) {
  const year = new Date(anchor).getUTCFullYear();
  let best: number | null = null;
  for (const y of [year - 1, year, year + 1]) {
    const value = utcDay(y, m, d);
    if (value !== null && (best === null || Math.abs(value - anchor) < Math.abs(best - anchor))) best = value;
  }
  return best;
}

function dateAtoms(text: string, options: TagOptions): DateAtom[] {
  const atoms: DateAtom[] = [];
  const push = (atom: DateAtom) => atoms.push(atom);
  const anchorDay = options.anchor === undefined ? undefined : Math.floor(options.anchor / DAY) * DAY;
  let match: RegExpExecArray | null;
  // ISO dates (times are handled by timeAtoms from the "T" onwards).
  for (const iso = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d])/g; (match = iso.exec(text));) {
    const value = utcDay(Number(match[1]), Number(match[2]), Number(match[3]));
    if (value !== null) push({ offset: match.index, end: match.index + match[0].length, y: Number(match[1]), m: Number(match[2]), d: Number(match[3]), grain: 'day', dayValue: value });
  }
  // "Friday, October 15, 2026", "Oct 15", "Oct. 15th 2026"
  for (const mdy = new RegExp(String.raw`(?<![\p{L}\d])(?:${WEEKDAY},?\s+)?${MONTH}\s+${ORDINAL}(?![\d:])(?:(?:,\s*|\s+)(\d{4})(?!\d))?`, 'giu'); (match = mdy.exec(text));) {
    const monthWord = match[1]!;
    if (!capitalised(match[0])) continue;
    const m = monthOf(monthWord)!, d = Number(match[2]);
    if (d < 1 || d > 31) continue;
    push({ offset: match.index, end: match.index + match[0].length, y: match[3] ? Number(match[3]) : undefined, m, d, grain: 'day' });
  }
  // "15 October 2026", "Friday 15th of Oct"
  for (const dmy = new RegExp(String.raw`(?<![\p{L}\d:/.-])(?:${WEEKDAY},?\s+)?(?:the\s+)?${ORDINAL}\s+(?:of\s+)?${MONTH}(?![\p{L}])(?:,?\s+(\d{4})(?!\d))?`, 'giu'); (match = dmy.exec(text));) {
    if (!capitalised(match[2]!)) continue;
    const m = monthOf(match[2]!)!, d = Number(match[1]);
    if (d < 1 || d > 31) continue;
    push({ offset: match.index, end: match.index + match[0].length, y: match[3] ? Number(match[3]) : undefined, m, d, grain: 'day' });
  }
  // "October 2026": month grain only.
  for (const my = new RegExp(String.raw`(?<![\p{L}\d])${MONTH},?\s+(\d{4})(?!\d)`, 'gu'); (match = my.exec(text));)
    push({ offset: match.index, end: match.index + match[0].length, y: Number(match[2]), m: monthOf(match[1]!)!, grain: 'month' });
  // 10/15/2026, 15/10/2026, 15.10.2026, 10/15/26
  for (const numeric = /(?<![\d/.])(\d{1,2})([/.])(\d{1,2})\2(\d{4}|\d{2})(?![\d/]|\.\d)/g; (match = numeric.exec(text));) {
    if (match[2] === '.' && match[4]!.length !== 4) continue;
    const a = Number(match[1]), b = Number(match[3]);
    const y = match[4]!.length === 2 ? 2000 + Number(match[4]) : Number(match[4]);
    const dmy = a > 12 ? true : b > 12 ? false : match[2] === '.' ? true : options.dateOrder === 'dmy';
    const [m, d] = dmy ? [b, a] : [a, b];
    const value = utcDay(y, m, d);
    if (value !== null) push({ offset: match.index, end: match.index + match[0].length, y, m, d, grain: 'day', dayValue: value });
  }
  // Year after a preposition: "in 2011", "since 2019".
  for (const year = /\b(?:in|since|during|from|until|by|of|year)\s+((?:19|20)\d{2})(?![\d/.-])/gi; (match = year.exec(text));) {
    const offset = match.index + match[0].length - 4;
    push({ offset, end: offset + 4, y: Number(match[1]), m: 1, grain: 'year' });
  }
  if (anchorDay === undefined) return atoms;
  for (const word = /\b(today|tonight|tomorrow|yesterday)\b/gi; (match = word.exec(text));) {
    const shift = { today: 0, tonight: 0, tomorrow: 1, yesterday: -1 }[match[1]!.toLowerCase() as 'today']!;
    push({ offset: match.index, end: match.index + match[0].length, m: 0, grain: 'day', relative: true, dayValue: anchorDay + shift * DAY });
  }
  for (const weekday = new RegExp(String.raw`\b(?:(this|next|last|coming)\s+)?(${WEEKDAY})(?![\p{L}])(?!,?\s*(?:${MONTH}\s*\d|\d))`, 'giu'); (match = weekday.exec(text));) {
    const word = match[2]!.replace(/\.$/, '');
    const modifier = match[1]?.toLowerCase();
    // A bare abbreviation ("Sat", "Sun") is too often an ordinary word; it needs a modifier.
    if (!capitalised(word) || (!modifier && word.length < 6)) continue;
    const target = WEEKDAYS[word.toLowerCase().slice(0, 3)];
    if (target === undefined) continue;
    const today = new Date(anchorDay).getUTCDay();
    let shift = (target - today + 7) % 7;
    if (modifier === 'next' && shift === 0) shift = 7;
    if (modifier === 'last') shift = -((today - target + 7) % 7 || 7);
    push({ offset: match.index, end: match.index + match[0].length, m: 0, grain: 'day', relative: true, dayValue: anchorDay + shift * DAY });
  }
  for (const span = /\b(?:in|within)\s+(\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|thirty)\s+(days?|weeks?)\b|\b(\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(days?|weeks?)\s+ago\b/gi; (match = span.exec(text));) {
    const raw = (match[1] ?? match[3])!.toLowerCase();
    const count = /^\d+$/.test(raw) ? Number(raw) : SMALL_NUMBERS[raw]!;
    const unit = (match[2] ?? match[4])!.toLowerCase().startsWith('week') ? 7 : 1;
    const sign = match[3] ? -1 : 1;
    push({ offset: match.index, end: match.index + match[0].length, m: 0, grain: 'day', relative: true, dayValue: anchorDay + sign * count * unit * DAY });
  }
  return atoms;
}

function timeAtoms(text: string): TimeAtom[] {
  const atoms: TimeAtom[] = [];
  let match: RegExpExecArray | null;
  const zoneAt = (end: number) => {
    const zone = new RegExp(String.raw`^\s*${ZONE}`, 'u').exec(text.slice(end, end + 16));
    return zone ? { zone: zone[1]!, end: end + zone[0].replace(/\s+$/, '').length } : { end };
  };
  // ISO time attached to an ISO date.
  for (const iso = /(?<=\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?(?![\d:])/g; (match = iso.exec(text));) {
    const zone = match[3] === undefined ? undefined : match[3] === 'Z' ? 'UTC' : `UTC${match[3]}`;
    atoms.push({ offset: match.index, end: match.index + match[0].length, h: Number(match[1]), min: Number(match[2]), zone, meridiem: true });
  }
  for (const clock = /(?<![\d:.])(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?![\p{L}])|(?<![\d:.T])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])|\b(noon|midnight)\b/giu; (match = clock.exec(text));) {
    if (atoms.some(atom => match!.index >= atom.offset && match!.index < atom.end)) continue;
    let h: number, min: number;
    const meridiem = Boolean(match[3] || match[6]);
    if (match[6]) [h, min] = [match[6].toLowerCase() === 'noon' ? 12 : 0, 0];
    else if (match[3]) {
      h = Number(match[1]); min = Number(match[2] ?? 0);
      if (h < 1 || h > 12) continue;
      const pm = match[3].toLowerCase().startsWith('p');
      h = (h % 12) + (pm ? 12 : 0);
    } else { h = Number(match[4]); min = Number(match[5]); }
    const end = match.index + match[0].replace(/\s+$/, '').length;
    const zoned = zoneAt(end);
    atoms.push({ offset: match.index, end: zoned.end, h, min, zone: zoned.zone, meridiem });
  }
  // "10-11am": the first hour borrows the second's meridiem.
  for (const bare = /(?<![\d:.])(\d{1,2})(?::([0-5]\d))?(?=\s*[-–]\s*\d{1,2}(?::[0-5]\d)?\s*([ap])\.?m)/gi; (match = bare.exec(text));) {
    const hour = Number(match[1]);
    if (hour < 1 || hour > 12 || atoms.some(atom => match!.index >= atom.offset && match!.index < atom.end)) continue;
    atoms.push({ offset: match.index, end: match.index + match[0].length, h: (hour % 12) + (match[3]!.toLowerCase() === 'p' ? 12 : 0),
      min: Number(match[2] ?? 0), meridiem: true });
  }
  return atoms.sort((a, b) => a.offset - b.offset);
}

/** Keep the longest atom where atoms overlap (a weekday-prefixed date beats the bare weekday). */
function longest<T extends { offset: number; end: number }>(atoms: T[]): T[] {
  const sorted = [...atoms].sort((a, b) => a.offset - b.offset || (b.end - b.offset) - (a.end - a.offset));
  const kept: T[] = [];
  for (const atom of sorted) {
    const last = kept.at(-1);
    if (last && atom.offset < last.end) {
      if (atom.end - atom.offset > last.end - last.offset) kept[kept.length - 1] = atom;
      continue;
    }
    kept.push(atom);
  }
  return kept;
}

function resolveDay(atom: DateAtom, anchor?: number): number | null {
  if (atom.dayValue !== undefined) return atom.dayValue;
  if (atom.grain !== 'day' || atom.d === undefined) return null;
  if (atom.y !== undefined) return utcDay(atom.y, atom.m, atom.d);
  return anchor === undefined ? null : inferYear(atom.m, atom.d, anchor);
}

function minuteValue(day: number, time: TimeAtom, options: TagOptions) {
  const offset = time.zone ? zoneOffset(time.zone, day) : null;
  return { value: day + (time.h * 60 + time.min) * MINUTE - (offset ?? options.defaultOffsetMinutes ?? 0) * MINUTE, floating: offset === null };
}

const between = (text: string, from: number, to: number) => from <= to ? text.slice(from, to) : '\u0000';
const DATE_TIME_GLUE = /^\s*(?:,|at|@|from|-|–|—|by|\||·)?\s*(?:at\s+)?$/i;
const TIME_DATE_GLUE = /^\s*(?:,|on)?\s*(?:on\s+)?$/i;
const RANGE_GLUE = /^\s*(?:-|–|—|to|through|thru|until|till)\s*$/i;

/** Tag temporal expressions in `text`. Results are ordered by offset and never overlap. */
export function tagTemporal(text: string, options: TagOptions = {}): TemporalMention[] {
  const dates = longest(dateAtoms(text, options));
  const times = timeAtoms(text).filter(time => !dates.some(date => time.offset < date.end && time.end > date.offset));
  const used = new Set<TimeAtom>();
  const mentions: TemporalMention[] = [];
  const make = (offset: number, end: number, values: number[], grain: TemporalGrain, kind: TemporalKind, days: number[], extra: Partial<TemporalMention> = {}) => {
    const start = values[0]!;
    const stop = values.length > 1 ? values.at(-1)! : start + (grain === 'minute' ? MINUTE : grain === 'day' ? DAY : 0);
    const coarseEnd = grain === 'month' ? Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() + 1, 1)
      : grain === 'year' ? Date.UTC(new Date(start).getUTCFullYear() + 1, 0, 1) : stop;
    mentions.push({ start, end: coarseEnd, quote: text.slice(offset, end), offset, grain, kind, days, values, ...extra });
  };
  /** Time(s) following a date: "Oct 15, 10am - 11am EST" or "Oct 15 at 11:59 PM EST". */
  const timesAfter = (position: number) => {
    const first = times.find(time => !used.has(time) && time.offset >= position && DATE_TIME_GLUE.test(between(text, position, time.offset)));
    if (!first) return [];
    const second = times.find(time => time !== first && !used.has(time) && time.offset >= first.end && RANGE_GLUE.test(between(text, first.end, time.offset)));
    return second ? [first, second] : [first];
  };
  for (let index = 0; index < dates.length; index++) {
    const date = dates[index]!;
    if (date.grain !== 'day') {
      if (date.y === undefined) continue;
      make(date.offset, date.end, [Date.UTC(date.y, date.m - 1, 1)], date.grain, 'date', []);
      continue;
    }
    const day = resolveDay(date, options.anchor);
    if (day === null) continue;
    let end = date.end;
    // "Aug 3 – Aug 5", "Aug 3-5", "Oct 1 to 15 October"
    const next = dates[index + 1];
    const dash = new RegExp(String.raw`^\s*(?:-|–|—|to|through|thru|until|till)\s*(\d{1,2})(?:st|nd|rd|th)?(?![\d:/.]|\s*(?:am|pm|a\.m|p\.m))`, 'i').exec(text.slice(end, end + 16));
    if (next && next.grain === 'day' && RANGE_GLUE.test(between(text, date.end, next.offset))) {
      const other = resolveDay(next.y === undefined && date.y !== undefined ? { ...next, y: date.y } : next, options.anchor);
      if (other !== null && other > day) {
        index++;
        make(date.offset, next.end, [day, other], 'day', 'range', [day, other], { relative: date.relative || next.relative });
        continue;
      }
    } else if (dash && date.d !== undefined && date.dayValue === undefined) {
      // "Aug 3-5, 2026": a trailing year belongs to both days.
      const trailing = date.y === undefined ? /^,?\s+((?:19|20)\d{2})(?!\d)/.exec(text.slice(end + dash[0].length, end + dash[0].length + 8)) : null;
      const first = trailing ? utcDay(Number(trailing[1]), date.m, date.d) : day;
      const year = new Date(first ?? day).getUTCFullYear(), month = new Date(first ?? day).getUTCMonth() + 1;
      const other = utcDay(year, month, Number(dash[1]));
      if (first !== null && other !== null && other > first) {
        make(date.offset, end + dash[0].length + (trailing?.[0].length ?? 0), [first, other], 'day', 'range', [first, other]);
        continue;
      }
    }
    const following = timesAfter(end);
    let preceding: TimeAtom[] = [];
    if (!following.length) {
      const last = [...times].reverse().find(time => !used.has(time) && time.end <= date.offset && TIME_DATE_GLUE.test(between(text, time.end, date.offset)));
      const first = last && [...times].reverse().find(time => !used.has(time) && time.end <= last.offset && RANGE_GLUE.test(between(text, time.end, last.offset)));
      preceding = last ? first ? [first, last] : [last] : [];
    }
    const clock = following.length ? following : preceding;
    if (!clock.length) {
      make(date.offset, end, [day], 'day', 'date', [day], { relative: date.relative });
      continue;
    }
    for (const time of clock) used.add(time);
    // A range's first time without a zone takes the second's ("10am - 11am EST").
    const zone = clock.at(-1)!.zone;
    const values = clock.map(time => minuteValue(day, { ...time, zone: time.zone ?? zone }, options));
    const offset = Math.min(date.offset, clock[0]!.offset);
    end = Math.max(end, clock.at(-1)!.end);
    if (values.length > 1 && values[1]!.value <= values[0]!.value) values.splice(1);
    make(offset, end, values.map(value => value.value), 'minute', values.length > 1 ? 'range' : 'date', [day],
      { floating: values.some(value => value.floating), relative: date.relative });
  }
  if (options.anchor !== undefined) {
    const anchorDay = Math.floor(options.anchor / DAY) * DAY, today = new Date(anchorDay).getUTCDay();
    for (const weekend of text.matchAll(/\b(this|next|the)\s+weekend\b/gi)) {
      if (mentions.some(mention => weekend.index! < mention.offset + mention.quote.length && weekend.index! + weekend[0].length > mention.offset)) continue;
      // Sunday still belongs to "this weekend"; "next weekend" is the one after.
      const saturday = anchorDay + ((today === 0 ? -1 : 6 - today) + (weekend[1]!.toLowerCase() === 'next' ? 7 : 0)) * DAY;
      make(weekend.index!, weekend.index! + weekend[0].length, [saturday, saturday + DAY], 'day', 'range', [saturday, saturday + DAY], { relative: true });
    }
  }
  mentions.sort((a, b) => a.offset - b.offset);
  for (const mention of mentions) {
    if (mention.kind === 'range') continue;
    const before = text.slice(Math.max(0, mention.offset - 48), mention.offset);
    if (DEADLINE_CUE.test(before)) mention.kind = 'deadline';
  }
  return mentions;
}

/** Day/minute timestamps a quote supports: every endpoint start and every written calendar day. */
export function supportedTimestamps(quote: string, options: TagOptions = {}): Set<number> {
  const values = new Set<number>();
  for (const mention of tagTemporal(quote, options)) {
    if (mention.grain !== 'day' && mention.grain !== 'minute') continue;
    for (const value of mention.values) values.add(value);
    for (const day of mention.days) values.add(day);
  }
  return values;
}

/** ISO rendering at the mention's grain: what a dated claim stores as its value. */
export function temporalValue(value: number, grain: TemporalGrain): string {
  const iso = new Date(value).toISOString();
  return grain === 'year' ? iso.slice(0, 4) : grain === 'month' ? iso.slice(0, 7) : grain === 'day' ? iso.slice(0, 10) : iso.replace(':00.000Z', 'Z');
}

/** The sentence (or line) around a span, as an exact substring bounded to `max` characters, for evidence quotes. */
export function sentenceAround(text: string, start: number, end: number, max = 240): { quote: string; offset: number } {
  let from = start, to = end;
  while (from > 0 && !/[.!?\n]/.test(text[from - 1]!) && start - from < max) from--;
  while (to < text.length && !/[!?\n]/.test(text[to]!) && !(text[to] === '.' && /\s/.test(text[to + 1] ?? ' ')) && to - end < max) to++;
  if (to < text.length && /[.!?]/.test(text[to]!)) to++;
  // Trim to the budget around the span, then whitespace, keeping an exact substring.
  if (to - from > max) {
    const spare = Math.max(0, max - (end - start));
    from = Math.max(from, start - Math.floor(spare / 2));
    to = Math.min(to, from + Math.max(max, end - start));
  }
  while (from < start && /\s/.test(text[from]!)) from++;
  while (to > end && /\s/.test(text[to - 1]!)) to--;
  return { quote: text.slice(from, to), offset: from };
}
