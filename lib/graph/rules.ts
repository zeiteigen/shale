import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { canonicalPredicate, isSystemPredicate, PREDICATES, predicateTokens } from './predicates';
import { typeFamily } from './ontology';
import { acronymKeys, emailKeys, nameKeys, registrableDomain, words } from './identity-keys';
import { tagTemporal } from './temporal';
import { canonicalResolver } from './patterns';
import { typeMention } from './mention-typing';

/**
 * A small stratified Datalog evaluator over graph claims. Rules are data: a body of binary atoms over canonical
 * predicates (with optional type and status filters, and negation), and a head atom. Facts are claims mapped onto
 * the typed schema (`canonicalPredicate`), read in both directions through declared inverses, between canonical
 * identities. Evaluation is semi-naive (each round joins only against facts new in the previous round), stratified
 * (a predicate is only negated once it is complete), and bounded. Every conclusion carries the claims it was
 * derived from as `dependsOn`, so retracting a premise makes the conclusion stale through the existing trigger.
 *
 * `GraphInference.transitive` is the one-rule special case (PART_OF ∘ PART_OF); it stays for its callers.
 */

export type Term = number | string;
export interface Fact { s: Term; o: Term; claimId?: string; dependsOn?: string[]; status?: string; validFrom?: number; validTo?: number }

export interface Atom {
  predicate: string;
  /** Variables start with '?'; anything else is a constant. */
  args: [string, string];
  /** Required type families of the two arguments (entity terms only). */
  types?: [string[] | undefined, string[] | undefined];
  statuses?: string[];
  negated?: boolean;
}

export interface Rule {
  id: string;
  description: string;
  body: Atom[];
  head: { predicate: string; args: [string, string] };
  /** Confidence written on conclusions. */
  confidence?: number;
  /**
   * Aggregate guard: keep a conclusion only when at least `min` distinct values of `distinct` support the same
   * values of `by` (≥2 people sharing one email domain). Only for non-recursive rules.
   */
  corroborate?: { distinct: string; by: string[]; min: number };
}

export interface Derivation {
  ruleId: string;
  subject: number;
  predicate: string;
  object: number;
  dependsOn: string[];
  validFrom?: number;
  validTo?: number;
  confidence: number;
  qualifiers: Record<string, string | number>;
}

const isVar = (term: string) => term.startsWith('?');
const factKey = (predicate: string, s: Term, o: Term) => `${predicate}\u0000${s}\u0000${o}`;

class FactSet {
  readonly byPredicate = new Map<string, { all: Fact[]; bySubject: Map<Term, Fact[]>; byObject: Map<Term, Fact[]> }>();
  readonly keys = new Set<string>();
  size = 0;
  add(predicate: string, fact: Fact) {
    const k = factKey(predicate, fact.s, fact.o);
    if (this.keys.has(k)) return false;
    this.keys.add(k); this.size++;
    let index = this.byPredicate.get(predicate);
    if (!index) { index = { all: [], bySubject: new Map(), byObject: new Map() }; this.byPredicate.set(predicate, index); }
    index.all.push(fact);
    (index.bySubject.get(fact.s) ?? index.bySubject.set(fact.s, []).get(fact.s)!).push(fact);
    (index.byObject.get(fact.o) ?? index.byObject.set(fact.o, []).get(fact.o)!).push(fact);
    return true;
  }
  has(predicate: string, s: Term, o: Term) { return this.keys.has(factKey(predicate, s, o)); }
  lookup(predicate: string, s?: Term, o?: Term): Fact[] {
    const index = this.byPredicate.get(predicate);
    if (!index) return [];
    if (s !== undefined) return (index.bySubject.get(s) ?? []).filter(fact => o === undefined || fact.o === o);
    if (o !== undefined) return index.byObject.get(o) ?? [];
    return index.all;
  }
}

/**
 * Strata by predicate: a head sits at or above its positive body predicates and strictly above negated ones.
 * Throws when negation is part of a cycle (the program has no stratified model).
 */
export function stratify(rules: Rule[]): Map<string, number> {
  const stratum = new Map<string, number>();
  const get = (predicate: string) => stratum.get(predicate) ?? 0;
  const predicates = new Set(rules.flatMap(rule => [rule.head.predicate, ...rule.body.map(atom => atom.predicate)]));
  for (let round = 0; round <= predicates.size + 1; round++) {
    let changed = false;
    for (const rule of rules) for (const atom of rule.body) {
      const needed = get(atom.predicate) + (atom.negated ? 1 : 0);
      if (get(rule.head.predicate) < needed) { stratum.set(rule.head.predicate, needed); changed = true; }
    }
    if (!changed) return stratum;
    if ([...stratum.values()].some(value => value > predicates.size)) break;
  }
  throw new Error('Rules are not stratifiable: negation inside a recursive cycle');
}

function validate(rule: Rule) {
  if (!rule.id || !/^[a-z0-9-]+$/.test(rule.id)) throw new Error(`Invalid rule id ${rule.id}`);
  const positive = new Set(rule.body.filter(atom => !atom.negated).flatMap(atom => atom.args.filter(isVar)));
  for (const term of [...rule.head.args, ...rule.body.filter(atom => atom.negated).flatMap(atom => atom.args)])
    if (isVar(term) && !positive.has(term)) throw new Error(`Rule ${rule.id} is unsafe: ${term} is not bound by a positive atom`);
  if (rule.corroborate && rule.body.some(atom => atom.predicate === rule.head.predicate))
    throw new Error(`Rule ${rule.id}: corroborated rules cannot be recursive`);
}

const INVERSE = new Map<string, string>();
for (const definition of PREDICATES) if (definition.inverse) {
  INVERSE.set(definition.name, definition.inverse);
  if (!INVERSE.has(definition.inverse)) INVERSE.set(definition.inverse, definition.name);
}
const SYMMETRIC = new Set([...PREDICATES.filter(definition => definition.symmetric).map(definition => definition.name), 'INTERACTED_WITH', 'ASSOCIATED_WITH']);

export interface FactOptions {
  /** Claim statuses that count as facts. */
  statuses?: string[];
  /** Proposed claims with a confidence below this are not facts (unscored proposals count). */
  minConfidence?: number;
  /** Methods whose claims are not premises (association edges are statistics, not assertions). */
  excludeMethods?: string[];
  limit?: number;
}

/**
 * Claims of the given canonical predicates (and their inverses, read backwards) as facts between canonical
 * identities. Raw model predicates are mapped through the schema, so "applied_for" is APPLIED_TO.
 */
export function loadClaimFacts(db: Database, predicates: Set<string>, options: FactOptions = {}) {
  const statuses = options.statuses ?? ['accepted', 'proposed'];
  const canonical = canonicalResolver(db);
  const facts = new Map<string, Fact[]>();
  const types = new Map<number, string>();
  const rows = db.query<{ id: string; predicate: string; subject_id: number; object_id: number; st: string; ot: string; status: string;
    confidence: number | null; valid_from: number | null; valid_to: number | null; method: string }, []>(`
    SELECT c.id,c.predicate,c.subject_id,c.object_id,s.type AS st,o.type AS ot,c.status,c.confidence,c.valid_from,c.valid_to,c.method
    FROM graph_claims c JOIN entities s ON s.id=c.subject_id JOIN entities o ON o.id=c.object_id
    WHERE c.object_id IS NOT NULL AND c.polarity=1 AND c.status IN (${statuses.map(status => `'${status.replace(/'/g, '')}'`).join(',')})
    LIMIT ${Math.trunc(options.limit ?? 200_000)}`).all();
  const exclude = new Set(options.excludeMethods ?? ['association']);
  for (const row of rows) {
    if (exclude.has(row.method)) continue;
    if (row.status === 'proposed' && row.confidence !== null && row.confidence < (options.minConfidence ?? 0.6)) continue;
    const predicate = isSystemPredicate(row.predicate) || predicates.has(row.predicate) ? row.predicate : canonicalPredicate(row.predicate, row.st, row.ot).predicate;
    const s = canonical(row.subject_id), o = canonical(row.object_id);
    if (s === o) continue;
    const base = { claimId: row.id, status: row.status, validFrom: row.valid_from ?? undefined, validTo: row.valid_to ?? undefined };
    const reverse = SYMMETRIC.has(predicate) ? predicate : INVERSE.get(predicate);
    if (predicates.has(predicate)) (facts.get(predicate) ?? facts.set(predicate, []).get(predicate)!).push({ s, o, ...base });
    if (reverse && predicates.has(reverse)) (facts.get(reverse) ?? facts.set(reverse, []).get(reverse)!).push({ s: o, o: s, ...base });
  }
  for (const row of db.query<{ id: number; type: string }, []>('SELECT id,type FROM entities WHERE canonical_id IS NULL').all()) types.set(row.id, row.type);
  return { facts, types };
}

export interface EvaluateOptions extends FactOptions {
  /** Conclusions per run, across all rules. */
  maxDerivations?: number;
  /** Join work per run (bindings examined). */
  maxWork?: number;
  /** Facts that do not come from claims (keys, computed relations), by predicate. */
  extraFacts?: Map<string, Fact[]>;
}

/** Evaluate rules stratum by stratum; conclusions that already hold as facts are not repeated. */
export function evaluateRules(db: Database, rules: Rule[], options: EvaluateOptions = {}) {
  for (const rule of rules) validate(rule);
  const strata = stratify(rules);
  const predicates = new Set(rules.flatMap(rule => [rule.head.predicate, ...rule.body.map(atom => atom.predicate)]));
  const { facts: loaded, types } = loadClaimFacts(db, predicates, options);
  for (const [predicate, list] of options.extraFacts ?? []) (loaded.get(predicate) ?? loaded.set(predicate, []).get(predicate)!).push(...list);
  const maxDerivations = options.maxDerivations ?? 500, maxWork = options.maxWork ?? 2_000_000;
  const familyOf = (term: Term) => typeof term === 'number' ? typeFamily(types.get(term) ?? '') : null;
  let old = new FactSet();
  let delta = new FactSet();
  for (const [predicate, list] of loaded) for (const fact of list) delta.add(predicate, fact);
  const derivations: Derivation[] = [];
  const perRule = new Map<string, number>();
  let work = 0, truncated = false;

  const fits = (atom: Atom, fact: Fact) => {
    if (atom.statuses && fact.status && !atom.statuses.includes(fact.status)) return false;
    for (const [index, term] of [fact.s, fact.o].entries()) {
      const allowed = atom.types?.[index];
      if (allowed && typeof term === 'number' && !allowed.includes(familyOf(term) ?? '')) return false;
    }
    return true;
  };
  const resolve = (term: string, binding: Map<string, Term>): Term | undefined => isVar(term) ? binding.get(term) : /^\d+$/.test(term) ? Number(term) : term;
  const holds = (atom: Atom, binding: Map<string, Term>) => {
    const s = resolve(atom.args[0], binding)!, o = resolve(atom.args[1], binding)!;
    return [...old.lookup(atom.predicate, s, o), ...delta.lookup(atom.predicate, s, o)].some(fact => fits(atom, fact));
  };

  /** All bindings of a rule body in which body atom `pivot` ranges over `delta` (earlier atoms over old, later over all). */
  function* join(rule: Rule, pivot: number, index = 0, binding = new Map<string, Term>(), used: Fact[] = []): Generator<{ binding: Map<string, Term>; used: Fact[] }> {
    if (index === rule.body.length) { yield { binding, used }; return; }
    const atom = rule.body[index]!;
    if (atom.negated) { if (!holds(atom, binding)) yield* join(rule, pivot, index + 1, binding, used); return; }
    const s = resolve(atom.args[0], binding), o = resolve(atom.args[1], binding);
    const sources = index === pivot ? [delta] : index < pivot ? [old] : [old, delta];
    for (const set of sources) for (const fact of set.lookup(atom.predicate, s, o)) {
      if (++work > maxWork) { truncated = true; return; }
      if (o !== undefined && fact.o !== o) continue;
      if (!fits(atom, fact)) continue;
      const next = new Map(binding);
      if (isVar(atom.args[0])) next.set(atom.args[0], fact.s);
      if (isVar(atom.args[1])) { if (atom.args[1] === atom.args[0] && fact.o !== fact.s) continue; next.set(atom.args[1], fact.o); }
      yield* join(rule, pivot, index + 1, next, [...used, fact]);
    }
  }

  const conclude = (rule: Rule, binding: Map<string, Term>, used: Fact[], fresh: FactSet, extra: Record<string, string | number> = {}) => {
    const s = resolve(rule.head.args[0], binding), o = resolve(rule.head.args[1], binding);
    if (typeof s !== 'number' || typeof o !== 'number' || s === o) return;
    if (old.has(rule.head.predicate, s, o) || delta.has(rule.head.predicate, s, o) || fresh.has(rule.head.predicate, s, o)) return;
    const reverse = SYMMETRIC.has(rule.head.predicate) ? rule.head.predicate : INVERSE.get(rule.head.predicate);
    if (reverse && (old.has(reverse, o, s) || delta.has(reverse, o, s) || fresh.has(reverse, o, s))) return;
    const from = Math.max(...used.map(fact => fact.validFrom ?? -Infinity)), to = Math.min(...used.map(fact => fact.validTo ?? Infinity));
    if (from >= to) return;
    if (derivations.length >= maxDerivations) { truncated = true; return; }
    const dependsOn = [...new Set(used.flatMap(fact => [...(fact.claimId ? [fact.claimId] : []), ...(fact.dependsOn ?? [])]))];
    const fact: Fact = { s, o, dependsOn, status: 'proposed', validFrom: Number.isFinite(from) ? from : undefined, validTo: Number.isFinite(to) ? to : undefined };
    fresh.add(rule.head.predicate, fact);
    const qualifiers: Record<string, string | number> = { rule: rule.id, ...extra };
    for (const [name, value] of binding) if (typeof value === 'string') qualifiers[name.slice(1)] = value;
    derivations.push({ ruleId: rule.id, subject: s, predicate: rule.head.predicate, object: o, dependsOn,
      validFrom: fact.validFrom, validTo: fact.validTo, confidence: rule.confidence ?? 0.6, qualifiers });
    perRule.set(rule.id, (perRule.get(rule.id) ?? 0) + 1);
  };

  const levels = [...new Set(rules.map(rule => strata.get(rule.head.predicate) ?? 0))].sort((a, b) => a - b);
  for (const level of levels) {
    // Each stratum starts naive: everything known so far is the first round's delta.
    for (const [predicate, index] of old.byPredicate) for (const fact of index.all) delta.add(predicate, fact);
    old = new FactSet();
    const active = rules.filter(rule => (strata.get(rule.head.predicate) ?? 0) === level);
    // Corroborated rules are aggregates over complete lower strata: one naive pass, grouped.
    const aggregated = new FactSet();
    for (const rule of active.filter(rule => rule.corroborate)) {
      const groups = new Map<string, { members: Set<Term>; rows: Array<{ binding: Map<string, Term>; used: Fact[] }> }>();
      for (const row of join(rule, rule.body.findIndex(atom => !atom.negated))) {
        const key = rule.corroborate!.by.map(name => String(row.binding.get(name))).join('\u0000');
        const group = groups.get(key) ?? { members: new Set<Term>(), rows: [] };
        group.members.add(row.binding.get(rule.corroborate!.distinct)!); group.rows.push(row);
        groups.set(key, group);
      }
      for (const group of groups.values()) if (group.members.size >= rule.corroborate!.min)
        for (const row of group.rows) conclude(rule, row.binding, row.used, aggregated, { corroborators: group.members.size });
    }
    for (const [predicate, index] of aggregated.byPredicate) for (const fact of index.all) delta.add(predicate, fact);
    const recursive = active.filter(rule => !rule.corroborate);
    for (let round = 0; round < 64 && delta.size && recursive.length && !truncated; round++) {
      const fresh = new FactSet();
      for (const rule of recursive) rule.body.forEach((atom, pivot) => {
        if (atom.negated || !delta.byPredicate.has(atom.predicate)) return;
        for (const row of join(rule, pivot)) conclude(rule, row.binding, row.used, fresh);
      });
      for (const [predicate, index] of delta.byPredicate) for (const fact of index.all) old.add(predicate, fact);
      delta = fresh;
    }
    for (const [predicate, index] of delta.byPredicate) for (const fact of index.all) old.add(predicate, fact);
    delta = new FactSet();
    if (truncated) break;
  }
  return { derivations, perRule: Object.fromEntries(perRule), truncated };
}

// ---------------------------------------------------------------------------------------------------------------
// Email-domain affiliation facts.

/** Free mail providers beyond identity-keys' list: a shared domain there says nothing about an employer. */
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'ymail.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'yandex.ru',
  'zoho.com', 'qq.com', '163.com', '126.com', 'msn.com', 'hotmail.ca', 'live.ca', 'hotmail.co.uk', 'yahoo.ca', 'yahoo.co.uk', 'fastmail.com',
  'hey.com', 'tutanota.com', 'duck.com', 'rocketmail.com']);
/** Mailboxes that are systems, not people: their domain is the sender's, not an affiliation. */
const AUTOMATED = /^(no-?reply|do-?not-?reply|notifications?|noti|info|hello|hi|support|help|team|news(letter)?|updates?|messages?|jobs|careers|alerts?|mail(er)?|marketing|admin|contact|service|accounts?|security|billing|receipts?|orders?|feedback|community|events?|digest|bounce|postmaster|reply|press|sales|store|shop|offers?|deals|promo(tions)?|rewards?|members?|membership|invitations?|invite|calendar|automated|system|robot|bot|webmaster)([._+-].*)?$/;
/** Labels of a registrable domain that name a suffix, not an organization ("edu.pk"). */
const SUFFIX_LABELS = new Set(['edu', 'ac', 'co', 'com', 'org', 'net', 'gov', 'gc', 'mil', 'sch', 'k12', 'mail', 'email']);
const STOP = new Set(['of', 'the', 'and', 'for', 'at', 'in', 'on', 'a', 'an', 'de', '&']);
/** Words of department and service mailboxes ("Michigan Admissions", "IT Accounts"), which display like names. */
const MAILBOX_WORDS = new Set(`admissions admission engineering housing accounts account office registrar services service center centre department desk
  recruitment events event chapter program programs programme student students life affairs international career careers team support info
  community foundation university college school club society institute academy lab labs group network alumni library store shop rewards hr it
  finance operations marketing sales communications news media press admin staff faculty research health security online digital newsletter
  notifications updates helpdesk help billing digest relations outreach partnerships ventures capital holdings global solutions systems`.split(/\s+/).filter(Boolean));

/** Whether a sender display name reads as a person ("Rita Bhowmik"), not a mailbox or an organization. */
export function personLike(display: string): boolean {
  const name = display.replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
  if (!name || /[@\d]/.test(name) || typeMention(name)) return false;
  const parts = name.split(/\s+/);
  // Every word capitalised, none a mailbox word or an acronym ("CCIR Schedule").
  return parts.length >= 2 && parts.length <= 4 && parts.every(part => /^\p{Lu}[\p{Ll}'’.-]*(?:-\p{Lu}[\p{Ll}'’.-]*)?$/u.test(part) && !MAILBOX_WORDS.has(part.toLowerCase()));
}

const TRAILING = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'co', 'group', 'team', 'community', 'official', 'org', 'organization']);

/**
 * Whether a domain label abbreviates a name: each word, in order, contributes a non-empty prefix ("uwaterloo" =
 * U + Waterloo, "umich" = U + Mich, "nyas" = N + Y + A + S, "lumiere" = Lumiere). Stopwords may be skipped
 * anywhere; trailing corporate words and parentheticals may be dropped. A multi-word reading must end on a
 * prefix of at least three letters unless every word gives one letter (an acronym).
 */
export function abbreviates(label: string, name: string): boolean {
  if (label.length < 3) return false;
  const all = words(name.replace(/\([^)]*\)/g, ' '));
  let end = all.length;
  while (end > 1 && (TRAILING.has(all[end - 1]!) || STOP.has(all[end - 1]!))) end--;
  const list = all.slice(0, end);
  const search = (i: number, j: number, used: number[]): boolean => {
    if (i === label.length) {
      if (!used.length) return false;
      const rest = list.slice(j).filter(word => !STOP.has(word));
      if (rest.length) return false;
      return used.length === 1 ? used[0] === list.find(word => !STOP.has(word))!.length && used[0]! >= 3
        : used.every(length => length === 1) || used.at(-1)! >= 3;
    }
    if (j >= list.length) return false;
    const word = list[j]!;
    if (STOP.has(word) && search(i, j + 1, used)) return true;
    for (let length = Math.min(word.length, label.length - i); length >= 1; length--)
      if (label.startsWith(word.slice(0, length), i) && search(i + length, j + 1, [...used, length])) return true;
    return false;
  };
  return search(0, 0, []);
}

/** Short names an organization's domain may take: its name keys and acronyms ("hackthenorth", "nhpc"). */
export function domainLabels(name: string): Set<string> {
  return new Set([...nameKeys(name), ...acronymKeys(name)].filter(label => label.length >= 3));
}

/** The organization-naming label of a registrable domain ("uwaterloo.ca" → uwaterloo), or null for suffix-only domains. */
export function domainLabel(domain: string): string | null {
  const label = registrableDomain(domain).split('.')[0]!.replace(/-/g, '');
  return label.length >= 3 && !SUFFIX_LABELS.has(label) ? label : null;
}

/**
 * Facts for the email-domain affiliation rule:
 * - `@EMAIL_DOMAIN(person, domain)` for people with a personal (non-automated, non-free-mail) address there. A
 *   "person" named after the domain ("Student Beans <hey@…>") is the organization's mailbox and is skipped. The
 *   fact cites one connector claim placing the person in a message, so conclusions inherit its visibility.
 * - `@ORG_DOMAIN(org, domain)` for organizations carrying that domain as a key, or whose name or alias abbreviates
 *   to its label ("University of Waterloo" ↔ uwaterloo.ca, "New York Academy of Sciences" ↔ nyas.org). A label
 *   that names more than three organizations is ambiguous and skipped.
 */
export function affiliationFacts(db: Database): Map<string, Fact[]> {
  const canonical = canonicalResolver(db);
  const people = new Map<number, Map<string, string | undefined>>();
  const addresses = db.query<{ entity_id: number; type: string; alias: string; scope: string; name: string }, []>(`
    SELECT a.entity_id,e.type,a.alias,a.scope,coalesce(e.display_name,e.name) AS name FROM graph_aliases a JOIN entities e ON e.id=a.entity_id
    WHERE a.scope='key:email' OR (a.scope='connector-key' AND a.alias GLOB 'email:user:*')`).all();
  const premise = db.query<{ id: string }, [number]>(`SELECT id FROM graph_claims WHERE object_id=? AND predicate GLOB 'ROLE:*'
    AND status IN ('accepted','proposed') ORDER BY recorded_at DESC LIMIT 1`);
  const names = new Map<number, string>();
  for (const row of addresses) {
    if (typeFamily(row.type) !== 'Person') continue;
    const address = row.scope === 'connector-key' ? row.alias.slice('email:user:'.length) : row.alias;
    const local = address.toLowerCase().split('@')[0] ?? '';
    const domain = emailKeys(address).find(key => key.kind === 'email-domain')?.value;
    if (!domain || FREE_MAIL.has(domain) || AUTOMATED.test(local)) continue;
    const label = domainLabel(domain);
    if (!label) continue;
    const person = canonical(row.entity_id);
    const name = names.get(person) ?? row.name;
    names.set(person, name);
    const display = name.replace(/<[^>]*>/g, '').trim();
    if (!personLike(display) || words(display).join('').includes(label) || domainLabels(display).has(label)) continue;
    const domains = people.get(person) ?? new Map<string, string | undefined>();
    if (!domains.has(domain)) domains.set(domain, premise.get(row.entity_id)?.id);
    people.set(person, domains);
  }
  const wanted = new Map<string, string>();
  for (const domains of people.values()) for (const domain of domains.keys()) wanted.set(domainLabel(domain)!, domain);
  // Name matches name the institution; a key match alone is often a department mailbox ("IT Accounts" at umich.edu).
  const named = new Map<string, Set<number>>(), keyed = new Map<string, Set<number>>();
  const put = (map: Map<string, Set<number>>, domain: string, org: number) => (map.get(domain) ?? map.set(domain, new Set()).get(domain)!).add(org);
  for (const row of db.query<{ entity_id: number; type: string; alias: string }, []>(`SELECT a.entity_id,e.type,a.alias FROM graph_aliases a
    JOIN entities e ON e.id=a.entity_id WHERE a.scope IN ('key:domain','key:email-domain')`).all()) {
    const domain = registrableDomain(row.alias);
    if (typeFamily(row.type) === 'Organization' && wanted.get(domainLabel(domain) ?? '') === domain) put(keyed, domain, canonical(row.entity_id));
  }
  for (const row of db.query<{ id: number; type: string; name: string }, []>(`SELECT e.id,e.type,coalesce(e.display_name,e.name) AS name FROM entities e
    UNION SELECT e.id,e.type,a.alias FROM graph_aliases a JOIN entities e ON e.id=a.entity_id WHERE a.scope IN ('','search')`).all()) {
    if (typeFamily(row.type) !== 'Organization' || /^entity:|^source:|[<@]/.test(row.name)) continue;
    for (const [label, domain] of wanted) if (domainLabels(row.name).has(label) || abbreviates(label, row.name)) put(named, domain, canonical(row.id));
  }
  const orgs = new Map<string, Set<number>>();
  for (const domain of new Set(wanted.values())) {
    const ids = named.get(domain)?.size ? named.get(domain)! : keyed.get(domain)?.size === 1 ? keyed.get(domain)! : undefined;
    if (ids && ids.size <= 3) orgs.set(domain, ids);
  }
  const emailFacts: Fact[] = [], orgFacts: Fact[] = [];
  for (const [person, domains] of people) for (const [domain, claimId] of domains)
    emailFacts.push({ s: person, o: domain, ...(claimId ? { claimId } : {}), status: 'accepted' });
  for (const [domain, ids] of orgs) for (const id of ids) orgFacts.push({ s: id, o: domain, status: 'accepted' });
  return new Map([['@EMAIL_DOMAIN', emailFacts], ['@ORG_DOMAIN', orgFacts]]);
}

// ---------------------------------------------------------------------------------------------------------------
// Rule set.

/** Canonical things; connector containers (servers, conversations, pages) have their own structural PART_OF. */
const THINGS = ['Organization', 'Project', 'Opportunity', 'Event', 'Artifact', 'Product', 'Place', 'Course', 'Concept'];

export const DEFAULT_RULES: Rule[] = [
  { id: 'applied-offered', description: 'Applying to an opportunity is an interaction with the organization that offers it.',
    body: [{ predicate: 'APPLIED_TO', args: ['?x', '?o'] }, { predicate: 'OFFERED_BY', args: ['?o', '?org'], types: [undefined, ['Organization', 'Community']] }],
    head: { predicate: 'INTERACTED_WITH', args: ['?x', '?org'] }, confidence: 0.7 },
  { id: 'part-of-transitive', description: 'A part of a part is a part (between things, not connector containers).',
    body: [{ predicate: 'PART_OF', args: ['?x', '?y'], types: [THINGS, THINGS] }, { predicate: 'PART_OF', args: ['?y', '?z'], types: [THINGS, THINGS] }],
    head: { predicate: 'PART_OF', args: ['?x', '?z'] }, confidence: 0.7 },
  { id: 'email-domain-affiliation', description: 'People writing from an organization\'s own mail domain are affiliated with it, once two people corroborate the domain.',
    body: [{ predicate: '@EMAIL_DOMAIN', args: ['?p', '?d'], types: [['Person'], undefined] },
      { predicate: '@ORG_DOMAIN', args: ['?org', '?d'], types: [['Organization', 'Community'], undefined] },
      { predicate: 'WORKS_AT', args: ['?p', '?org'], negated: true }, { predicate: 'STUDIES_AT', args: ['?p', '?org'], negated: true },
      { predicate: 'MEMBER_OF', args: ['?p', '?org'], negated: true }],
    head: { predicate: 'AFFILIATED_WITH', args: ['?p', '?org'] }, confidence: 0.65, corroborate: { distinct: '?p', by: ['?org', '?d'], min: 2 } },
];

export const derivationId = (derivation: Pick<Derivation, 'ruleId' | 'subject' | 'predicate' | 'object'>) =>
  `rule:${derivation.ruleId}:${createHash('sha256').update(JSON.stringify([derivation.subject, derivation.predicate, derivation.object])).digest('hex').slice(0, 32)}`;

interface ClaimWriter {
  claims: { add(input: { id: string; subject: number; predicate: string; object: number; status: 'proposed'; method: string; confidence: number;
    qualifiers: Record<string, string | number>; dependsOn: string[]; validFrom?: number; validTo?: number }): unknown };
  relations: { get(name: string): unknown; define(definition: { name: string; description?: string; symmetric?: boolean }): void };
}

/** Write conclusions as proposed claims (method `rule:<id>`), idempotently by (rule, subject, predicate, object). */
export function commitDerivations(db: Database, graph: ClaimWriter, derivations: Derivation[]) {
  if (!graph.relations.get('INTERACTED_WITH')) graph.relations.define({ name: 'INTERACTED_WITH', symmetric: true, description: 'dealt with directly (applied to, wrote to, bought from)' });
  let created = 0, skipped = 0;
  const exists = db.query('SELECT 1 FROM graph_claims WHERE id=?');
  for (const derivation of derivations) {
    const id = derivationId(derivation);
    if (exists.get(id)) { skipped++; continue; }
    try {
      graph.claims.add({ id, subject: derivation.subject, predicate: derivation.predicate, object: derivation.object, status: 'proposed',
        method: `rule:${derivation.ruleId}`, confidence: derivation.confidence, qualifiers: derivation.qualifiers, dependsOn: derivation.dependsOn,
        validFrom: derivation.validFrom, validTo: derivation.validTo });
      created++;
    } catch { skipped++; } // A premise retracted since evaluation: the next run will not derive it.
  }
  return { created, skipped };
}

// ---------------------------------------------------------------------------------------------------------------
// Functional-property conflicts.

const FUNCTIONAL = new Set(PREDICATES.filter(definition => definition.functional).map(definition => definition.name));
const DATE_PREDICATES = new Set(PREDICATES.filter(definition => definition.value === 'date').map(definition => definition.name));
/** Words that name the predicate itself; what remains of a raw predicate is its facet ("early", "abstract", "transfer"). */
const FACET_NOISE = new Set(['have', 'deadline', 'due', 'date', 'time', 'day', 'application', 'apply', 'on', 'by', 'at', 'is', 'of', 'for', 'schedule',
  'scheduled', 'occur', 'happen', 'hold', 'take', 'place', 'offer', 'offered', 'post', 'posted', 'provide', 'employer', 'run', 'operate', 'publish',
  'valid', 'event', 'submission', 'registration']);
/** Words that change which date is meant collapse into one class each, so "expires" and "end_date" agree. */
const FACET_CLASS: Record<string, string> = { start: 'start', begin: 'start', open: 'start', launch: 'start', end: 'end', expire: 'end',
  expiry: 'end', expiration: 'end', close: 'end', closing: 'end', finish: 'end', until: 'end' };
/**
 * One-off things have one deadline or date; recurring ones (a promo code reused every campaign, a payment service,
 * a product sold by many shops) legitimately have many, so their "conflicts" would be noise.
 */
const ONE_OFF = new Set(['Opportunity', 'Event', 'Course', 'Project']);

export interface Conflict { a: string; b: string; predicate: string; subject: number; reason: string }

/** Calendar days a date value names, or null when it is not a date the temporal grammar reads. */
function days(value: unknown, anchor: number): number[] | null {
  if (typeof value === 'number' && Number.isFinite(value)) return [Math.floor(value / 86_400_000) * 86_400_000];
  if (typeof value !== 'string') return null;
  const mention = tagTemporal(value, { anchor })[0];
  return mention?.days.length ? mention.days : null;
}

/**
 * Pairs of live claims of a functional predicate (one current target per subject: deadlines, start and end dates,
 * the offering organization) that name different targets for the same canonical subject and facet, overlap in
 * validity, and come from different sources. Same-source pairs are usually two facets the model did not name
 * ("round 1" and "round 2" deadlines), so a conflict means two sources disagree. Dates are compared by day.
 */
export function functionalConflicts(db: Database, options: { statuses?: string[]; limit?: number } = {}): Conflict[] {
  const statuses = options.statuses ?? ['accepted', 'proposed'];
  const canonical = canonicalResolver(db);
  const functional = new Set(FUNCTIONAL);
  for (const row of db.query<{ name: string; definition: string }, []>('SELECT name,definition FROM graph_relations').all())
    try { if (JSON.parse(row.definition).maxTargets === 1) functional.add(row.name); } catch { /* malformed definition */ }
  const rows = db.query<{ id: string; predicate: string; subject_id: number; object_id: number | null; value_json: string | null; st: string; ot: string | null;
    context: string; valid_from: number | null; valid_to: number | null; observed_at: number; sources: string | null }, []>(`
    SELECT c.id,c.predicate,c.subject_id,c.object_id,c.value_json,s.type AS st,o.type AS ot,c.context,c.valid_from,c.valid_to,c.observed_at,
      (SELECT group_concat(DISTINCT r.source_id) FROM graph_evidence ev JOIN graph_source_revisions r ON r.id=ev.revision_id WHERE ev.claim_id=c.id) AS sources
    FROM graph_claims c JOIN entities s ON s.id=c.subject_id LEFT JOIN entities o ON o.id=c.object_id
    WHERE c.polarity=1 AND c.status IN (${statuses.map(status => `'${status.replace(/'/g, '')}'`).join(',')}) AND c.method NOT GLOB 'rule:*'`).all();
  const groups = new Map<string, Array<{ id: string; target: string; dayset: number[] | null; from: number; to: number; sources: Set<string>; predicate: string; subject: number }>>();
  for (const row of rows) {
    if (isSystemPredicate(row.predicate)) continue;
    const predicate = functional.has(row.predicate) ? row.predicate : canonicalPredicate(row.predicate, row.st, row.object_id === null ? null : row.ot ?? undefined).predicate;
    if (!functional.has(predicate) || !ONE_OFF.has(typeFamily(row.st))) continue;
    const facet = [...new Set(predicateTokens(row.predicate).filter(token => !FACET_NOISE.has(token)).map(token => FACET_CLASS[token] ?? token))].sort().join('_');
    const subject = canonical(row.subject_id);
    let target: string, dayset: number[] | null = null;
    if (row.object_id !== null) target = `entity:${canonical(row.object_id)}`;
    else {
      const value = JSON.parse(row.value_json!);
      if (DATE_PREDICATES.has(predicate)) { dayset = days(value, row.observed_at); if (!dayset) continue; target = `days:${dayset.join(',')}`; }
      else target = `value:${JSON.stringify(value).toLowerCase()}`;
    }
    const k = `${subject}\u0000${predicate}\u0000${row.context}\u0000${facet}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push({ id: row.id, target, dayset, from: row.valid_from ?? -Infinity, to: row.valid_to ?? Infinity,
      sources: new Set((row.sources ?? '').split(',').filter(Boolean)), predicate, subject });
  }
  const conflicts: Conflict[] = [];
  const limit = options.limit ?? 1000;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!, b = list[j]!;
      if (a.target === b.target || Math.max(a.from, b.from) >= Math.min(a.to, b.to)) continue;
      // A range that contains the other's day is not a disagreement ("June 1–5" vs "June 3").
      if (a.dayset && b.dayset && a.dayset.some(day => b.dayset!.includes(day))) continue;
      if (!a.sources.size || !b.sources.size || [...a.sources].some(source => b.sources.has(source))) continue;
      const [first, second] = a.id < b.id ? [a, b] : [b, a];
      conflicts.push({ a: first.id, b: second.id, predicate: a.predicate, subject: a.subject, reason: `different ${a.predicate} targets: ${a.target} vs ${b.target}` });
      if (conflicts.length >= limit) return conflicts;
    }
  }
  return conflicts;
}

/** Record conflicts as `contradicts` claim links (read by GraphConflicts.find); nothing is retracted. */
export function linkConflicts(db: Database, conflicts: Conflict[]) {
  let linked = 0;
  const exists = db.query("SELECT 1 FROM graph_claim_links WHERE relation='contradicts' AND ((source_id=?1 AND target_id=?2) OR (source_id=?2 AND target_id=?1))");
  const insert = db.query("INSERT OR IGNORE INTO graph_claim_links(source_id,target_id,relation) VALUES(?,?,'contradicts')");
  db.transaction(() => { for (const conflict of conflicts) if (!exists.get(conflict.a, conflict.b) && insert.run(conflict.a, conflict.b).changes) linked++; })();
  return linked;
}
