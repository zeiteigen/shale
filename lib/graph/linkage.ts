import type { Database } from 'bun:sqlite';
import { acronymKeys, fullNameKey, registrableDomain, words } from './identity-keys';
import { typeFamily } from './ontology';
import { DEFAULT_LINKAGE_MODEL } from './linkage-default';

/**
 * Record linkage for identity pairs: features computed from names, keys, descriptions, and the graph around
 * each identity, scored by a logistic model trained on the model's own past same/different verdicts in
 * graph_resolution_queue. Confident scores settle queued pairs without the model; the rest still go to it,
 * and its new verdicts become the next training labels.
 */

// ---------------------------------------------------------------------------------------------------------
// Pure similarity functions

export function jaro(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  if (!a.length || !b.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aHit = new Array<boolean>(a.length).fill(false), bHit = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j++)
      if (!bHit[j] && a[i] === b[j]) { aHit[i] = bHit[j] = true; matches++; break; }
  if (!matches) return 0;
  let transpositions = 0;
  for (let i = 0, j = 0; i < a.length; i++) {
    if (!aHit[i]) continue;
    while (!bHit[j]) j++;
    if (a[i] !== b[j++]) transpositions++;
  }
  return (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
}

export function jaroWinkler(a: string, b: string, scale = 0.1): number {
  const similarity = jaro(a, b);
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return similarity + prefix * scale * (1 - similarity);
}

export function jaccard<T>(a: Iterable<T>, b: Iterable<T>): number {
  const left = new Set(a), right = new Set(b);
  if (!left.size && !right.size) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared++;
  return shared / (left.size + right.size - shared);
}

export const tokenJaccard = (a: string, b: string) => jaccard(words(a), words(b));

/** Shared tokens weighted by rarity, over the lighter side: a shared rare surname outweighs a shared "Ali". */
export function idfOverlap(a: string[], b: string[], idf: (token: string) => number): number {
  const left = new Set(a), right = new Set(b);
  const weight = (set: Set<string>) => [...set].reduce((sum, token) => sum + idf(token), 0);
  const lighter = Math.min(weight(left), weight(right));
  if (!lighter) return 0;
  return weight(new Set([...left].filter(token => right.has(token)))) / lighter;
}

export function tfidfCosine(a: string[], b: string[], idf: (token: string) => number): number {
  const vector = (tokens: string[]) => {
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const [token, count] of counts) counts.set(token, (1 + Math.log(count)) * idf(token));
    return counts;
  };
  const left = vector(a), right = vector(b);
  let dot = 0, ln = 0, rn = 0;
  for (const [token, value] of left) { ln += value * value; dot += value * (right.get(token) ?? 0); }
  for (const value of right.values()) rn += value * value;
  return ln && rn ? dot / Math.sqrt(ln * rn) : 0;
}

/** Fraction of the shorter interval covered by the other ([start, end] in ms). */
export function intervalOverlap(a: [number, number] | null, b: [number, number] | null): number {
  if (!a || !b) return 0;
  const shared = Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
  if (shared < 0) return 0;
  const shorter = Math.min(a[1] - a[0], b[1] - b[0]);
  return shorter <= 0 ? 1 : Math.min(1, shared / shorter);
}

const NICKNAME_GROUPS = [
  ['william', 'will', 'bill', 'billy', 'liam'], ['robert', 'rob', 'bob', 'bobby', 'robbie'], ['james', 'jim', 'jimmy', 'jamie'],
  ['michael', 'mike', 'mikey'], ['alexander', 'alex', 'sasha', 'xander'], ['alexandra', 'alex', 'lexi', 'sandra'],
  ['elizabeth', 'liz', 'beth', 'lizzie', 'eliza', 'betty'], ['katherine', 'kate', 'katie', 'kathy', 'kat', 'catherine'],
  ['richard', 'rick', 'rich', 'dick'], ['thomas', 'tom', 'tommy'], ['christopher', 'chris'], ['christina', 'chris', 'tina'],
  ['daniel', 'dan', 'danny'], ['david', 'dave'], ['joseph', 'joe', 'joey'], ['jonathan', 'jon', 'john', 'johnny'],
  ['matthew', 'matt'], ['nicholas', 'nick', 'nicky'], ['anthony', 'tony'], ['edward', 'ed', 'eddie', 'ted'],
  ['benjamin', 'ben', 'benny'], ['samuel', 'sam', 'sammy'], ['samantha', 'sam'], ['andrew', 'andy', 'drew'],
  ['stephen', 'steve', 'steven'], ['jennifer', 'jen', 'jenny'], ['margaret', 'maggie', 'meg', 'peggy'],
  ['victoria', 'vicky', 'tori'], ['patricia', 'pat', 'patty'], ['patrick', 'pat'], ['charles', 'charlie', 'chuck'],
  ['henry', 'harry', 'hank'], ['muhammad', 'mohammad', 'mohammed', 'muhammed', 'mohamed'], ['abdullah', 'abdul'],
  ['zachary', 'zach', 'zack'], ['jacob', 'jake'], ['joshua', 'josh'], ['nathaniel', 'nathan', 'nate'], ['timothy', 'tim'],
  ['gregory', 'greg'], ['kenneth', 'ken', 'kenny'], ['ronald', 'ron'], ['donald', 'don'], ['susan', 'sue', 'susie'],
];
const NICKNAMES = new Map<string, Set<string>>();
for (const group of NICKNAME_GROUPS) for (const name of group) {
  const set = NICKNAMES.get(name) ?? new Set<string>();
  for (const other of group) set.add(other);
  NICKNAMES.set(name, set);
}
const TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'professor', 'sir', 'madam', 'mx', 'jr', 'sr', 'ii', 'iii']);

/** Whether two given names can denote one person: equal, nickname, initial, or a prefix of three letters or more. */
export function givenNamesCompatible(a: string, b: string): boolean {
  if (a === b || NICKNAMES.get(a)?.has(b)) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short);
}

/**
 * Person-name compatibility: 1 when full names agree up to nicknames, initials, and small typos
 * ("J. Redekopp" ~ "James Redekopp"), 0.5 when one side is a single given name or surname of the other,
 * 0 otherwise; `conflict` when both are full names that cannot be one person.
 */
export function personNames(a: string, b: string): { compatible: number; conflict: number } {
  const tokens = (label: string) => words(stripEmail(label)).filter(token => !TITLES.has(token));
  const left = tokens(a), right = tokens(b);
  if (!left.length || !right.length) return { compatible: 0, conflict: 0 };
  if (left.join(' ') === right.join(' ')) return { compatible: 1, conflict: 0 };
  if (left.length >= 2 && right.length >= 2) {
    const surname = left.at(-1)!, otherSurname = right.at(-1)!;
    const sameSurname = surname === otherSurname || (Math.min(surname.length, otherSurname.length) >= 4 && jaroWinkler(surname, otherSurname) >= 0.93);
    const ok = sameSurname && givenNamesCompatible(left[0]!, right[0]!);
    return ok ? { compatible: 1, conflict: 0 } : { compatible: 0, conflict: 1 };
  }
  const [single, full] = left.length === 1 ? [left[0]!, right] : [right[0]!, left];
  return { compatible: givenNamesCompatible(single, full[0]!) || single === full.at(-1) ? 0.5 : 0, conflict: 0 };
}

/** Whether one name is the other's acronym ("NHPC" ~ "Northbridge High Performance Computing"). */
export function acronymMatch(a: string, b: string): boolean {
  const ak = fullNameKey(a), bk = fullNameKey(b);
  if (!ak || !bk || ak === bk) return false;
  return acronymKeys(a).includes(bk) || acronymKeys(b).includes(ak);
}

/**
 * How well an email address fits a name: its local part spells the full name or initial + surname
 * ("jredekopp" ~ "James Redekopp"), or its domain is the organization's name ("tradingview.com" ~ "TradingView").
 */
export function emailNameMatch(email: string, name: string): number {
  const [local = '', domain = ''] = email.toLowerCase().split('@');
  const letters = local.replace(/[^a-z]/g, '');
  const tokens = words(stripEmail(name)).filter(token => !TITLES.has(token) && /\p{L}/u.test(token));
  if (!letters || !tokens.length) return 0;
  const compactName = tokens.join('');
  const site = registrableDomain(domain).split('.')[0] ?? '';
  if (letters === compactName || (compactName.length >= 4 && site === compactName)) return 1;
  if (tokens.length >= 2) {
    const first = tokens[0]!, last = tokens.at(-1)!;
    if (last.length >= 3 && letters.includes(last) && (letters.includes(first) || letters.startsWith(first[0]!) || letters.endsWith(first[0]!))) return 1;
    if (last.length >= 4 && letters.includes(last)) return 0.5;
    if (first.length >= 4 && letters.startsWith(first)) return 0.5;
  } else if (tokens[0]!.length >= 4 && letters.includes(tokens[0]!)) return 0.5;
  return 0;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
/** Calendar dates in text as month-day keys ("August 10, 2026", "10 Aug", "2026-08-10", "8/10/2026" → "8-10"). */
export function datesIn(text: string): string[] {
  const found = new Set<string>(), lower = text.toLowerCase();
  const add = (month: number, day: number) => { if (month >= 1 && month <= 12 && day >= 1 && day <= 31) found.add(`${month}-${day}`); };
  const monthOf = (name: string) => MONTHS.indexOf(name.slice(0, 3)) + 1;
  for (const m of lower.matchAll(new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g'))) add(monthOf(m[1]!), Number(m[2]));
  for (const m of lower.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, 'g'))) add(monthOf(m[2]!), Number(m[1]));
  for (const m of lower.matchAll(/\b\d{4}-(\d{2})-(\d{2})\b/g)) add(Number(m[1]), Number(m[2]));
  for (const m of lower.matchAll(/\b(\d{1,2})\/(\d{1,2})\/\d{2,4}\b/g)) add(Number(m[1]), Number(m[2]));
  return [...found];
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** "TradingView <noreply@tradingview.com>" → "TradingView"; a bare address stays as it is. */
export function stripEmail(label: string): string {
  const stripped = label.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped || label.trim();
}
export const emailsIn = (label: string) => [...label.matchAll(EMAIL)].map(match => match[0].toLowerCase());

/** Words that name an edition or platform of a product: "ChatGPT iOS" is not "ChatGPT Web". */
const VARIANTS = new Set(['ios', 'android', 'web', 'mobile', 'desktop', 'mac', 'macos', 'windows', 'linux', 'app', 'api', 'cli',
  'pro', 'plus', 'lite', 'mini', 'max', 'premium', 'enterprise', 'beta', 'v1', 'v2', 'v3', 'v4', 'v5']);

const DESCRIPTION_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'who', 'which', 'are', 'was', 'were',
  'has', 'have', 'its', 'their', 'into', 'about', 'also', 'been', 'being', 'such', 'they', 'them', 'than', 'one', 'two']);
export const descriptionTokens = (text: string) => words(text).filter(token => token.length >= 3 && !DESCRIPTION_STOPWORDS.has(token) && !/^\d+$/.test(token));

// ---------------------------------------------------------------------------------------------------------
// Features

export const FEATURES = [
  'jw', 'jaccard', 'idf', 'exact', 'contained', 'rare', 'single', 'acronym',
  'personCompatible', 'personConflict', 'personExact', 'personSingle',
  'emailName', 'sameEmail', 'emailConflict', 'sameDomain', 'accountConflict',
  'coParticipant', 'dateMatch', 'dateConflict', 'numberConflict', 'variant', 'eventExact',
  'description', 'descriptionMissing', 'neighbors', 'sharedNeighbors', 'sources', 'coMention', 'origins', 'temporal', 'gap',
  'person', 'organization', 'concept', 'event', 'place', 'work',
] as const;
export type FeatureName = typeof FEATURES[number];
export type Features = Record<FeatureName, number>;

/** What the features need to know about one side of a pair. */
export interface LinkageSide {
  type: string; names: string[]; emails: string[]; keys: Map<string, Set<string>>; description: string;
  /** Calendar dates the records state (month-day), from descriptions and literal claim values. */
  dates: Set<string>;
  /** Events the records take part in (as sender, recipient, participant, host, …). */
  events: Set<number>;
  sources: Set<string>; origins: Set<string>; span: [number, number] | null; neighbors: Set<number>;
}
export interface Idf { name: (token: string) => number; description: (token: string) => number; maxName: number }

/** Features of a pair of sides (pure; `pairFeatures` loads the sides from the database). */
export function sideFeatures(a: LinkageSide, b: LinkageSide, idf: Idf): Features {
  const f = Object.fromEntries(FEATURES.map(name => [name, 0])) as Features;
  const family = typeFamily(a.type), person = family === 'Person';
  const leftNames = [...new Set(a.names.map(stripEmail))].slice(0, 24), rightNames = [...new Set(b.names.map(stripEmail))].slice(0, 24);
  let minTokens = Infinity;
  for (const left of leftNames) for (const right of rightNames) {
    const lw = words(left), rw = words(right);
    if (!lw.length || !rw.length) continue;
    minTokens = Math.min(minTokens, lw.length, rw.length);
    f.jw = Math.max(f.jw, jaroWinkler(lw.join(' '), rw.join(' ')));
    f.jaccard = Math.max(f.jaccard, jaccard(lw, rw));
    f.idf = Math.max(f.idf, idfOverlap(lw, rw, idf.name));
    const lk = fullNameKey(left), rk = fullNameKey(right);
    if (lk && lk === rk) f.exact = 1;
    const [short, long] = lw.length <= rw.length ? [lw, rw] : [rw, lw];
    if (short.every(token => long.includes(token))) f.contained = 1;
    const shared = lw.filter(token => rw.includes(token));
    if (shared.length) f.rare = Math.max(f.rare, Math.max(...shared.map(idf.name)) / idf.maxName);
    if (acronymMatch(left, right)) f.acronym = 1;
    if (shared.length && [...lw, ...rw].some(token => VARIANTS.has(token) && !(lw.includes(token) && rw.includes(token)))) f.variant = 1;
    if (person) {
      const names = personNames(left, right);
      f.personCompatible = Math.max(f.personCompatible, names.compatible);
      f.personConflict = Math.max(f.personConflict, names.conflict);
    }
  }
  // A conflict only counts when no name pair is compatible (people go by several names).
  if (f.personCompatible >= 1) f.personConflict = 0;
  f.single = minTokens === 1 ? 1 : 0;
  for (const email of a.emails) for (const name of rightNames) f.emailName = Math.max(f.emailName, emailNameMatch(email, name));
  for (const email of b.emails) for (const name of leftNames) f.emailName = Math.max(f.emailName, emailNameMatch(email, name));
  const keys = (side: LinkageSide, kind: string) => side.keys.get(kind) ?? new Set<string>();
  const emailsA = new Set([...a.emails, ...keys(a, 'email')]), emailsB = new Set([...b.emails, ...keys(b, 'email')]);
  if ([...emailsA].some(email => emailsB.has(email))) f.sameEmail = 1;
  else if (emailsA.size && emailsB.size) f.emailConflict = 1;
  const domains = (side: LinkageSide) => new Set([...keys(side, 'email-domain'), ...keys(side, 'domain')]);
  const domainsB = domains(b);
  if ([...domains(a)].some(domain => domainsB.has(domain))) f.sameDomain = 1;
  const accountsA = keys(a, 'discord-user'), accountsB = keys(b, 'discord-user');
  if (accountsA.size && accountsB.size && ![...accountsA].some(account => accountsB.has(account))) f.accountConflict = 1;
  if (a.description && b.description)
    f.description = tfidfCosine(descriptionTokens(a.description), descriptionTokens(b.description), idf.description);
  else f.descriptionMissing = 1;
  // Two parties of one conversation or transaction are two parties.
  if ([...a.events].some(event => b.events.has(event))) f.coParticipant = 1;
  // Recurring sales, deadlines, and meetings share a name; their dates tell them apart.
  if (a.dates.size && b.dates.size) {
    if ([...a.dates].some(date => b.dates.has(date))) f.dateMatch = 1;
    else f.dateConflict = 1;
  }
  const numbers = (names: string[]) => new Set(names.flatMap(name => words(name).filter(token => /\d/.test(token))));
  const numbersA = numbers(leftNames), numbersB = numbers(rightNames);
  if (numbersA.size && numbersB.size && ![...numbersA].some(value => numbersB.has(value))) f.numberConflict = 1;
  f.neighbors = jaccard(a.neighbors, b.neighbors);
  let sharedNeighbors = 0;
  for (const id of a.neighbors) if (b.neighbors.has(id)) sharedNeighbors++;
  f.sharedNeighbors = Math.min(1, Math.log1p(sharedNeighbors) / Math.log(20));
  f.sources = jaccard(a.sources, b.sources);
  f.coMention = [...a.sources].some(source => b.sources.has(source)) ? 1 : 0;
  f.origins = jaccard(a.origins, b.origins);
  f.temporal = intervalOverlap(a.span, b.span);
  if (a.span && b.span) {
    const gap = Math.max(0, Math.max(a.span[0], b.span[0]) - Math.min(a.span[1], b.span[1]));
    f.gap = Math.min(1, Math.log1p(gap / 86_400_000) / Math.log(366));
  }
  f.person = person ? 1 : 0;
  f.personExact = person ? f.exact : 0;
  f.personSingle = person ? f.single : 0;
  f.eventExact = family === 'Event' || family === 'Opportunity' ? f.exact : 0;
  f.organization = family === 'Organization' || family === 'Community' ? 1 : 0;
  f.concept = family === 'Concept' ? 1 : 0;
  f.event = family === 'Event' || family === 'Opportunity' ? 1 : 0;
  f.place = family === 'Place' ? 1 : 0;
  f.work = ['Artifact', 'Product', 'Project', 'Course'].includes(family) ? 1 : 0;
  return f;
}

/** The person-band rule: at least one piece of evidence beyond names and descriptions. */
export const relationalEvidence = (f: Features) =>
  f.sharedNeighbors > 0 || f.sameEmail > 0 || f.emailName >= 1 || f.sameDomain > 0;

// ---------------------------------------------------------------------------------------------------------
// Loading sides from the graph

const SUBTREE = 'WITH RECURSIVE m(id) AS (SELECT ?1 UNION SELECT e.id FROM entities e JOIN m ON e.canonical_id=m.id) SELECT id FROM m';

function rootOf(db: Database, id: number): number {
  const seen = new Set<number>();
  for (let current = id; ;) {
    const row = db.query<{ canonical_id: number | null }, [number]>('SELECT canonical_id FROM entities WHERE id=?').get(current);
    if (!row || row.canonical_id === null || seen.has(current)) return current;
    seen.add(current);
    current = row.canonical_id;
  }
}
const subtree = (db: Database, id: number) => db.query<{ id: number }, [number]>(SUBTREE).all(id).map(row => row.id);

/**
 * The members on each side of a pair. Separate identities contribute their whole canonical groups. When the
 * pair is already merged (a past "same" verdict being replayed for training), the mention's own subtree is
 * split from the rest of the group, so features describe the records as they were before the merge.
 */
export function pairMembers(db: Database, a: number, b: number): [number[], number[]] {
  const ra = rootOf(db, a), rb = rootOf(db, b);
  if (ra !== rb) return [subtree(db, ra), subtree(db, rb)];
  const group = subtree(db, ra);
  const underA = new Set(subtree(db, a));
  if (!underA.has(b)) return [[...underA], group.filter(id => !underA.has(id))];
  const underB = new Set(subtree(db, b));
  return [group.filter(id => !underB.has(id)), [...underB]];
}

const placeholders = (ids: unknown[]) => ids.map(() => '?').join(',');

export function loadSide(db: Database, ids: number[], context: LinkageContext, exclude: Set<number> = new Set()): LinkageSide {
  const list = placeholders(ids);
  const type = db.query<{ type: string }, [number]>('SELECT type FROM entities WHERE id=?').get(ids[0]!)?.type ?? '';
  const names = db.query<{ name: string }, number[]>(`SELECT coalesce(display_name,name) AS name FROM entities WHERE id IN (${list})
    UNION SELECT alias FROM graph_aliases WHERE entity_id IN (${list}) AND (scope IN ('','search') OR scope GLOB 'source:*') LIMIT 40`)
    .all(...ids, ...ids).map(row => row.name).filter(name => !/^(entity:)?(extracted|connector):[0-9a-f]{16,}$/.test(name));
  const keys = new Map<string, Set<string>>();
  for (const row of db.query<{ alias: string; scope: string }, number[]>(
    `SELECT alias,scope FROM graph_aliases WHERE entity_id IN (${list}) AND scope GLOB 'key:*' AND scope!='key:none'`).all(...ids)) {
    const kind = row.scope.slice(4), set = keys.get(kind) ?? new Set<string>();
    set.add(row.alias.toLowerCase());
    keys.set(kind, set);
  }
  const emails = [...new Set(names.flatMap(emailsIn))];
  const descriptionRow = db.query<{ value_json: string }, number[]>(`SELECT value_json FROM graph_claims WHERE subject_id IN (${list})
    AND predicate='DESCRIPTION' AND status IN ('accepted','proposed') ORDER BY recorded_at DESC LIMIT 1`).get(...ids);
  let description = '';
  try { const value = descriptionRow ? JSON.parse(descriptionRow.value_json) : ''; description = typeof value === 'string' ? value : ''; } catch { /* none */ }
  const values = db.query<{ value_json: string }, number[]>(`SELECT value_json FROM graph_claims WHERE subject_id IN (${list})
    AND value_json IS NOT NULL AND status IN ('accepted','proposed') AND predicate NOT IN ('SUMMARY') LIMIT 40`).all(...ids);
  const dates = new Set([description, ...values.map(row => row.value_json)].flatMap(datesIn));
  const sources = db.query<{ id: string; origin: string; at: number }, number[]>(`SELECT DISTINCT s.id,s.origin,s.updated_at AS at
    FROM source_entities se JOIN sources s ON s.id=se.source_id WHERE se.entity_id IN (${list}) ORDER BY s.updated_at DESC LIMIT 200`).all(...ids);
  const times = sources.map(source => source.at).filter(Number.isFinite);
  const sourceIds = sources.map(source => source.id);
  const raw = new Set<number>();
  if (sourceIds.length) for (const row of db.query<{ id: number }, string[]>(`SELECT DISTINCT entity_id AS id FROM source_entities
    WHERE source_id IN (${placeholders(sourceIds)}) LIMIT 3000`).all(...sourceIds)) raw.add(row.id);
  for (const row of db.query<{ id: number }, number[]>(`SELECT object_id AS id FROM graph_claims WHERE subject_id IN (${list})
      AND object_id IS NOT NULL AND status IN ('accepted','proposed') AND predicate NOT IN ('PART_OF_EPISODE','DESCRIPTION')
    UNION SELECT subject_id FROM graph_claims WHERE object_id IN (${list}) AND status IN ('accepted','proposed')
      AND predicate NOT IN ('PART_OF_EPISODE','MENTIONS_ENTITY') LIMIT 3000`).all(...ids, ...ids)) raw.add(row.id);
  const neighbors = new Set<number>();
  for (const id of raw) {
    if (exclude.has(id)) continue;
    const root = context.root(id);
    if (!exclude.has(root) && root !== context.self) neighbors.add(root);
  }
  const events = new Set(db.query<{ id: number }, number[]>(`SELECT DISTINCT subject_id AS id FROM graph_claims WHERE object_id IN (${list})
    AND predicate GLOB 'ROLE:*' AND status IN ('accepted','proposed') LIMIT 2000`).all(...ids).map(row => row.id));
  return { type, names, emails, keys, description, dates, events, sources: new Set(sourceIds), origins: new Set(sources.map(source => source.origin)),
    span: times.length ? [Math.min(...times), Math.max(...times)] : null, neighbors };
}

/** Corpus statistics shared by many pair scorings: token rarity of names and descriptions, and the self identity. */
export interface LinkageContext { idf: Idf; self: number | null; root: (id: number) => number }

const contexts = new WeakMap<Database, { at: number; context: LinkageContext }>();
const CONTEXT_TTL = 10 * 60_000;

export function linkageContext(db: Database, fresh = false): LinkageContext {
  const cached = contexts.get(db);
  if (cached && !fresh && Date.now() - cached.at < CONTEXT_TTL) return cached.context;
  const nameDf = new Map<string, number>(), descriptionDf = new Map<string, number>();
  let nameDocs = 0, descriptionDocs = 0;
  for (const row of db.query<{ name: string }, []>(`SELECT coalesce(display_name,name) AS name FROM entities
    WHERE canonical_id IS NULL AND type NOT IN ('ChatSession','Conversation','WebPage','Image','Note')`).iterate()) {
    nameDocs++;
    for (const token of new Set(words(stripEmail(row.name)))) nameDf.set(token, (nameDf.get(token) ?? 0) + 1);
  }
  for (const row of db.query<{ value_json: string }, []>("SELECT value_json FROM graph_claims WHERE predicate='DESCRIPTION'").iterate()) {
    descriptionDocs++;
    for (const token of new Set(descriptionTokens(row.value_json))) descriptionDf.set(token, (descriptionDf.get(token) ?? 0) + 1);
  }
  const idf = (df: Map<string, number>, docs: number) => (token: string) => Math.log((docs + 1) / ((df.get(token) ?? 0) + 1)) + 1;
  const roots = new Map<number, number>();
  const context: LinkageContext = {
    idf: { name: idf(nameDf, nameDocs), description: idf(descriptionDf, descriptionDocs), maxName: Math.log(nameDocs + 1) + 1 },
    self: db.query<{ id: number }, []>("SELECT id FROM entities WHERE stable_id='self'").get()?.id ?? null,
    root: id => { let root = roots.get(id); if (root === undefined) roots.set(id, root = rootOf(db, id)); return root; },
  };
  contexts.set(db, { at: Date.now(), context });
  return context;
}

/** Features of a queued pair (mention, candidate), following canonical groups. */
export function pairFeatures(db: Database, a: number, b: number, context = linkageContext(db)): Features {
  const [left, right] = pairMembers(db, a, b);
  const exclude = new Set([...left, ...right, rootOf(db, a), rootOf(db, b)]);
  return sideFeatures(loadSide(db, left, context, exclude), loadSide(db, right, context, exclude), context.idf);
}

// ---------------------------------------------------------------------------------------------------------
// Model: L2-regularised logistic regression, shrunk toward a prior model when one is given

export interface LinkageModel {
  version: 1; weights: Partial<Record<FeatureName, number>>; bias: number; trainedAt: number; labels: number; origin: string;
}
export interface LinkageExample { features: Features; label: 0 | 1 }

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function score(model: LinkageModel, features: Features): number {
  let z = model.bias;
  for (const name of FEATURES) z += (model.weights[name] ?? 0) * (features[name] ?? 0);
  return sigmoid(z);
}

/** Solve A x = b in place by Gaussian elimination with partial pivoting. */
function solve(matrix: number[][], vector: number[]): number[] {
  const n = vector.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(matrix[row]![col]!) > Math.abs(matrix[pivot]![col]!)) pivot = row;
    [matrix[col], matrix[pivot]] = [matrix[pivot]!, matrix[col]!];
    [vector[col], vector[pivot]] = [vector[pivot]!, vector[col]!];
    const head = matrix[col]![col]! || 1e-12;
    for (let row = col + 1; row < n; row++) {
      const factor = matrix[row]![col]! / head;
      if (!factor) continue;
      for (let k = col; k < n; k++) matrix[row]![k]! -= factor * matrix[col]![k]!;
      vector[row]! -= factor * vector[col]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = vector[row]!;
    for (let k = row + 1; k < n; k++) sum -= matrix[row]![k]! * x[k]!;
    x[row] = sum / (matrix[row]![row]! || 1e-12);
  }
  return x;
}

/**
 * Fit by Newton's method. The penalty `l2 * |w - prior|²` keeps weights near the prior model's, so a small
 * local label set adjusts the shipped weights instead of replacing them; the bias is not penalised.
 */
export function train(examples: LinkageExample[], options: { l2?: number; prior?: LinkageModel; iterations?: number; origin?: string } = {}): LinkageModel {
  const l2 = options.l2 ?? 1, n = FEATURES.length + 1;
  const prior = [options.prior?.bias ?? 0, ...FEATURES.map(name => options.prior?.weights[name] ?? 0)];
  let w = [...prior];
  const rows = examples.map(example => [1, ...FEATURES.map(name => example.features[name] ?? 0)]);
  // Penalised negative log-likelihood, for the line search.
  const loss = (weights: number[]) => rows.reduce((sum, x, index) => {
    const z = x.reduce((total, value, k) => total + value * weights[k]!, 0);
    return sum + Math.log1p(Math.exp(-Math.abs(z))) + Math.max(z, 0) - examples[index]!.label * z;
  }, 0) + weights.reduce((sum, value, k) => sum + (k ? l2 / 2 * (value - prior[k]!) ** 2 : 0), 0);
  let current = loss(w);
  for (let iteration = 0; iteration < (options.iterations ?? 50); iteration++) {
    const gradient = new Array<number>(n).fill(0);
    const hessian = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    rows.forEach((x, index) => {
      const p = sigmoid(x.reduce((sum, value, k) => sum + value * w[k]!, 0));
      const error = p - examples[index]!.label, weight = p * (1 - p);
      for (let j = 0; j < n; j++) {
        if (!x[j]) continue;
        gradient[j]! += error * x[j]!;
        for (let k = 0; k < n; k++) if (x[k]) hessian[j]![k]! += weight * x[j]! * x[k]!;
      }
    });
    for (let j = 1; j < n; j++) { gradient[j]! += l2 * (w[j]! - prior[j]!); hessian[j]![j]! += l2; }
    // A saturated start (the prior far from these labels) leaves the bias curvature near zero; damp it.
    hessian[0]![0]! += 1e-2;
    const step = solve(hessian, gradient);
    // Backtracking: Newton steps overshoot when predictions start saturated.
    let scale = 1, next = w, nextLoss = current;
    for (let tries = 0; tries < 30; tries++, scale /= 2) {
      next = w.map((value, k) => value - scale * step[k]!);
      nextLoss = loss(next);
      if (nextLoss <= current) break;
    }
    if (nextLoss > current) break;
    const moved = Math.max(...step.map(value => Math.abs(value * scale)));
    w = next; current = nextLoss;
    if (moved < 1e-6) break;
  }
  return { version: 1, bias: round(w[0]!), weights: Object.fromEntries(FEATURES.map((name, k) => [name, round(w[k + 1]!)])),
    trainedAt: Date.now(), labels: examples.length, origin: options.origin ?? 'trained' };
}
const round = (value: number) => Math.round(value * 1e4) / 1e4;

// ---------------------------------------------------------------------------------------------------------
// Labels, storage, and refits

export const MODEL_STATE_KEY = 'linkage-model-v1';
const EXTENSION = 'knowledge-graph';

/**
 * Verdicts usable as labels: the model's same/different decisions. Bookkeeping rows (superseded, already
 * merged, incompatible kinds) and rule decisions (exact names, linkage itself, cannot-link) are excluded, so
 * the linkage model learns from its teacher and never from its own output.
 */
export const LABEL_FILTER = `state IN ('same','different')
  AND coalesce(reason,'') NOT IN ('superseded by merge','already the same entity','different kinds of thing')
  AND coalesce(reason,'') NOT GLOB 'same * name' AND coalesce(reason,'') NOT GLOB 'linkage*' AND coalesce(reason,'') NOT GLOB 'cannot-link*'`;

export interface LabelledPair { mention: number; candidate: number; label: 0 | 1; decidedAt: number; type: string }
export function labelledPairs(db: Database): LabelledPair[] {
  return db.query<{ mention: number; candidate: number; state: string; at: number; type: string }, []>(`SELECT q.mention_id AS mention,
    q.candidate_id AS candidate,q.state,coalesce(q.decided_at,q.created_at) AS at,e.type FROM graph_resolution_queue q
    JOIN entities e ON e.id=q.mention_id JOIN entities c ON c.id=q.candidate_id WHERE ${LABEL_FILTER}
    ORDER BY at`).all().map(row => ({ mention: row.mention, candidate: row.candidate, label: row.state === 'same' ? 1 : 0, decidedAt: row.at, type: row.type }));
}

/** Fit on the queue's labels (or given pairs); `prior: null` fits from zero instead of shrinking toward the shipped weights. */
export function trainFromDatabase(db: Database, options: { prior?: LinkageModel | null; l2?: number; pairs?: LabelledPair[] } = {}): LinkageModel {
  const context = linkageContext(db, true);
  const examples = (options.pairs ?? labelledPairs(db)).map(pair => ({ features: pairFeatures(db, pair.mention, pair.candidate, context), label: pair.label }));
  return train(examples, { prior: options.prior === null ? undefined : options.prior ?? DEFAULT_LINKAGE_MODEL, l2: options.l2 ?? 2, origin: 'local' });
}

export function storedModel(db: Database): LinkageModel | null {
  const row = db.query<{ value: string }, [string, string]>('SELECT value FROM extension_state WHERE extension_id=? AND state_key=?')
    .get(EXTENSION, MODEL_STATE_KEY);
  try { const model = row ? JSON.parse(row.value) as LinkageModel : null; return model?.version === 1 ? model : null; } catch { return null; }
}

export function storeModel(db: Database, model: LinkageModel) {
  db.query(`INSERT INTO extension_state(extension_id,state_key,value,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(extension_id,state_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .run(EXTENSION, MODEL_STATE_KEY, JSON.stringify(model), Date.now());
}

/** The current model: the locally trained one if any, else the shipped weights. */
export const loadModel = (db: Database): LinkageModel => storedModel(db) ?? DEFAULT_LINKAGE_MODEL;

/**
 * Refit from the queue when the teacher has said enough new things: no local model yet and at least
 * `minLabels` labels, or a model older than `minAgeMs` with `minNewLabels` labels since. Returns the
 * model in force and whether it was refit.
 */
export function refreshModel(db: Database, options: { minLabels?: number; minNewLabels?: number; minAgeMs?: number } = {}) {
  const stored = storedModel(db);
  const labels = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM graph_resolution_queue WHERE ${LABEL_FILTER}`).get()!.n;
  const due = stored
    ? labels - stored.labels >= (options.minNewLabels ?? 50) && Date.now() - stored.trainedAt >= (options.minAgeMs ?? 86_400_000)
    : labels >= (options.minLabels ?? 200);
  if (!due) return { model: stored ?? DEFAULT_LINKAGE_MODEL, refit: false };
  const model = trainFromDatabase(db);
  storeModel(db, model);
  return { model, refit: true };
}

/** Probability that a queued pair names one identity. */
export function linkageProbability(db: Database, a: number, b: number, model = loadModel(db)): number {
  return score(model, pairFeatures(db, a, b));
}

/** A scorer `(db, mention, candidate) => p` for evaluation harnesses; context and model are loaded once per database. */
export function createScorer(db: Database, model = loadModel(db)) {
  const context = linkageContext(db);
  return (target: Database, mention: number, candidate: number) =>
    score(model, pairFeatures(target, mention, candidate, target === db ? context : linkageContext(target)));
}

/**
 * Evaluation hook for scripts/eval/identity.ts: fit from zero on the training split's model verdicts (the
 * shipped weights saw every production label, so they would leak the test split), then score pairs. Pairs
 * the band rules would never settle as "same" (people without relational evidence, dated things whose dates
 * disagree, product editions, co-participants, distinct accounts) are capped at 0.9, below any "same" band.
 */
export function createIdentityScorer(db: Database, labels: Array<{ mentionId: number; candidateId: number; same: boolean; decidedAt: number; type: string; decider?: string }>) {
  const pairs = labels.filter(label => label.decider !== 'rule').map(label => ({ mention: label.mentionId, candidate: label.candidateId,
    label: (label.same ? 1 : 0) as 0 | 1, decidedAt: label.decidedAt, type: label.type }));
  const model = trainFromDatabase(db, { pairs, prior: null, l2: 1 });
  const context = linkageContext(db);
  return (target: Database, mention: number, candidate: number) => {
    const features = pairFeatures(target, mention, candidate, target === db ? context : linkageContext(target));
    const p = score(model, features);
    return bandVerdict(1, features, { ...DEFAULT_BANDS, personSame: 0 }) === null ? Math.min(p, 0.9) : p;
  };
}

export interface LinkageBands { same: number; different: number; personSame: number }
export const DEFAULT_BANDS: LinkageBands = { same: 0.97, different: 0.1, personSame: 0.95 };

/**
 * The band a score falls in. People need a stricter score and some relational evidence for "same",
 * because two people sharing a name is the error the model makes most.
 */
export function bandVerdict(p: number, features: Features, bands: LinkageBands = DEFAULT_BANDS): 'same' | 'different' | null {
  if (p <= bands.different) return 'different';
  // Two parties of one conversation or transaction, or two accounts, are never one identity by score alone.
  if (features.coParticipant || features.accountConflict) return null;
  if (features.person) return p >= bands.personSame && relationalEvidence(features) ? 'same' : null;
  // Recurring sales, deadlines, and meetings reuse one name: a dated thing needs its date to agree.
  if (features.work && features.variant) return null;
  if (features.event) return p >= bands.same && features.dateMatch && !features.dateConflict ? 'same' : null;
  return p >= bands.same ? 'same' : null;
}

/** The strongest contributions to a score, for audit reasons. */
export function explain(model: LinkageModel, features: Features, count = 3): string {
  return FEATURES.map(name => [name, (model.weights[name] ?? 0) * features[name]] as const).filter(([, value]) => value)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, count)
    .map(([name, value]) => `${name} ${value > 0 ? '+' : ''}${value.toFixed(1)}`).join(', ');
}
