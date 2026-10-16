import { canonicalType, type CanonicalType } from './ontology';
import { textReferences, urlKeys } from './identity-keys';
import { COMMON_WORDS } from './gazetteer';

/**
 * New-mention detection and typing without a model. Mentions come from capitalised phrases (the `namePhrases`
 * chunker, with offsets), email display names, course codes, and identifying URLs. Types come from a head-noun and
 * suffix lexicon ("… University" → Organization, "CS 136" → Course, "… Fellowship" → Opportunity). Unknown heads
 * return null: guessing Concept would mint junk entities, and the residual model pass can type them instead.
 */
export interface Mention {
  name: string;
  type: CanonicalType | null;
  /** Exact substring of the input at `offset`. */
  quote: string;
  offset: number;
  kind: 'phrase' | 'email' | 'course' | 'url';
  /** Identifying link or address, for identity keys. */
  url?: string;
}

/** Heads the ontology's synonym table does not decide on its own, or decides differently for proper names. */
const HEADS: Record<string, CanonicalType> = {
  university: 'Organization', college: 'Organization', inc: 'Organization', llc: 'Organization', ltd: 'Organization',
  gmbh: 'Organization', corp: 'Organization', co: 'Organization', club: 'Organization', lab: 'Organization', labs: 'Organization',
  institute: 'Organization', foundation: 'Organization', society: 'Organization', academy: 'Organization', school: 'Organization',
  association: 'Organization', council: 'Organization', committee: 'Organization', department: 'Organization', team: 'Organization',
  internship: 'Opportunity', scholarship: 'Opportunity', program: 'Opportunity', programme: 'Opportunity', fellowship: 'Opportunity',
  mentorship: 'Opportunity', competition: 'Opportunity', olympiad: 'Opportunity', bootcamp: 'Opportunity', prize: 'Opportunity',
  hackathon: 'Event', conference: 'Event', interview: 'Event', webinar: 'Event', meeting: 'Event', workshop: 'Event',
  summit: 'Event', symposium: 'Event', seminar: 'Event', expo: 'Event', fair: 'Event', orientation: 'Event',
  repo: 'Artifact', repository: 'Artifact', doc: 'Artifact', docs: 'Artifact', document: 'Artifact', spreadsheet: 'Artifact',
  slides: 'Artifact', deck: 'Artifact', report: 'Artifact', resume: 'Artifact', thesis: 'Artifact', paper: 'Artifact', form: 'Artifact',
};
/** Synonym-table heads that name roles or ideas rather than ending a proper name ("Dear Student", "Big Idea"). */
const NOT_HEADS = new Set(['user', 'people', 'person', 'human', 'individual', 'contact', 'author', 'recruiter', 'student', 'topic',
  'concept', 'idea', 'field', 'subject', 'skill', 'class', 'file', 'url', 'call', 'role', 'position', 'job', 'application', 'event',
  'project', 'product', 'service', 'tool', 'place', 'location', 'group', 'community', 'organization', 'company', 'opportunity', 'episode']);
const LEADING = /^(?:(?:The|A|An|Hi|Hello|Hey|Dear|Thanks|Thank|Best|Regards|Sincerely|Cheers|Re|Fwd|Fw|From|To|Subject|Date|Sent|Cc|On|In|At|For|With|This|That|These|Those|Our|Your|My|We|You|I|If|When|Please|Join|Apply|Register|Click|View|Learn|Read|Get|Meet|See|Check|Ask|Tell|Let|Contact|Visit|Use|Find|Start|Make|Send|Email|Call|Reply|Follow|Watch|Try|Explore|Discover|Shop|Save|Book|Sign|Log|Welcome|Congratulations|Congrats|Note|Update|Reminder|Important|Hey|And|Or|But|So|Also|All|New|Free|Today|Tomorrow|Yes|No|OK|Ok)\s+)+/;
/** Course codes: department letters and a number ("CS 136", "MATH137", "ECE 250L"); not model numbers or standards. */
const COURSE = /\b([A-Z]{2,5}) ?(\d{2,4}[A-Z]?)\b/g;
const NOT_COURSE = new Set(['COVID', 'ISO', 'RTX', 'GTX', 'HTTP', 'UTC', 'GMT', 'EST', 'EDT', 'PST', 'PDT', 'CST', 'CDT', 'RFC', 'USB',
  'CVE', 'SKU', 'ID', 'IP', 'MAC', 'IOS', 'AWS', 'PS', 'RX', 'GPT', 'RAM', 'SSD', 'HDD', 'FY', 'Q', 'PM', 'AM', 'NO', 'TO', 'AT', 'IN',
  'ON', 'OF', 'BY', 'UP', 'US', 'UK', 'CA', 'EU', 'AD', 'BC', 'CE', 'TV', 'PC', 'MP', 'GB', 'MB', 'KB', 'TB', 'HD', 'DDR', 'LTE', 'FIFA',
  'TOP', 'API', 'WWDC', 'CES', 'MIT', 'PIN', 'OTP', 'SMS', 'ZIP', 'VAT', 'NCT', 'PO', 'DM', 'CHF', 'USD', 'CAD', 'EUR', 'GBP', 'INR']);
const CALENDAR = /^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)$/;

/** Type a name from its form alone; null when nothing in it says what it is. */
export function typeMention(name: string): CanonicalType | null {
  const clean = name.trim().replace(/[.,;:!?]+$/, '');
  if (!clean) return null;
  COURSE.lastIndex = 0;
  const course = COURSE.exec(clean);
  if (course && course.index === 0 && !NOT_COURSE.has(course[1]!) && course[0].length >= clean.length - 1) return 'Course';
  if (/^(?:University|College|Institute|Bank|Museum|Department|School|Faculty|Society|Academy|Church|Ministry|Government) of\b/i.test(clean)) return 'Organization';
  const words = clean.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length < 2 && !/^(?:Inc|LLC|Ltd)$/i.test(clean)) return null;
  const head = words.at(-1)!.toLowerCase();
  if (HEADS[head]) return HEADS[head]!;
  if (NOT_HEADS.has(head)) return null;
  const type = canonicalType(head);
  // canonicalType falls back to Concept for anything unknown; a fallback is not evidence.
  return type === 'Concept' || type === 'Person' || type === 'Episode' ? null : type;
}

const PHRASE = /(?:\b(?:\p{Lu}[\p{L}\p{N}&'-]*|\p{Lu}{2,}[\p{N}]*)(?:[ \t]+(?:of|the|and|for|de|at|in)?[ \t]*(?:\p{Lu}[\p{L}\p{N}&'-]*)){0,5})/gu;

/** Display names that are mailboxes, not people. */
const MAILBOX = /\b(?:team|support|notifications?|no-?reply|newsletter|info|news|hello|admin|admissions|careers|jobs|alerts?|digest|updates|service|help|billing|marketing)\b/i;

/** Candidate new mentions in a text window, in order of appearance, deduplicated by name. */
export function detectMentions(text: string, limit = 80): Mention[] {
  const found = new Map<string, Mention>();
  const add = (mention: Mention) => {
    const key = mention.name.toLowerCase();
    if (found.size < limit && !found.has(key)) found.set(key, mention);
  };
  // "Jane Doe <jane@uni.edu>": the display name of a person, unless it is a mailbox.
  for (const match of text.matchAll(/(?:^|[\s:,;>])"?(\p{Lu}[\p{L}'’.-]+(?:[ \t]+\p{Lu}[\p{L}'’.-]+){1,3})"?[ \t]*<([^<>\s@]+@[^<>\s]+)>/gmu)) {
    const name = match[1]!, offset = match.index! + match[0].indexOf(name);
    const type = MAILBOX.test(name) ? typeMention(name) : typeMention(name) ?? 'Person';
    add({ name, type, quote: name, offset, kind: 'email', url: match[2]!.toLowerCase() });
  }
  COURSE.lastIndex = 0;
  for (const match of text.matchAll(COURSE)) {
    if (NOT_COURSE.has(match[1]!) || /^[\d.,%]/.test(text.slice(match.index! + match[0].length, match.index! + match[0].length + 1))) continue;
    add({ name: match[0], type: 'Course', quote: match[0], offset: match.index!, kind: 'course' });
  }
  for (const match of text.matchAll(PHRASE)) {
    let phrase = match[0].trim(), offset = match.index!;
    const leading = LEADING.exec(phrase);
    if (leading) { phrase = phrase.slice(leading[0].length); offset += leading[0].length; }
    phrase = phrase.replace(/[\s'-]+$/, '');
    if (phrase.length < 3 || phrase.length > 80 || CALENDAR.test(phrase)) continue;
    // A capitalised ordinary word ("Applications", "Details") is sentence case, not a name.
    if (!/\s/.test(phrase) && !/\p{Lu}.*\p{Lu}|\d/u.test(phrase) && [phrase.toLowerCase(), phrase.toLowerCase().replace(/s$/, '')].some(word => COMMON_WORDS.has(word))) continue;
    add({ name: phrase, type: typeMention(phrase), quote: phrase, offset, kind: 'phrase' });
  }
  for (const url of textReferences(text).urls) {
    const keys = urlKeys(url);
    const offset = text.indexOf(url);
    const github = keys.find(key => key.kind === 'github' && key.value.includes('/'));
    const linkedin = keys.find(key => key.kind === 'linkedin');
    if (github) add({ name: github.value, type: 'Artifact', quote: url, offset, kind: 'url', url });
    else if (linkedin) add({ name: linkedin.value.split('/')[1]!, type: linkedin.value.startsWith('in/') ? 'Person' : 'Organization', quote: url, offset, kind: 'url', url });
  }
  return [...found.values()].sort((a, b) => a.offset - b.offset);
}
