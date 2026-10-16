import { afterEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { abbreviates, affiliationFacts, commitDerivations, DEFAULT_RULES, derivationId, evaluateRules, functionalConflicts, linkConflicts,
  personLike, stratify, type Rule } from '../lib/graph/rules';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = createTestDatabase(); databases.push(db);
  const sdk = createExtensionSDK('knowledge-graph', { database: db, namespace: 'knowledge' });
  const entity = (name: string, type: string) => sdk.graph.entities.create({ name, type }).id;
  const claim = (subject: number, predicate: string, object: number, extra: Record<string, unknown> = {}) =>
    sdk.graph.claims.add({ subject, predicate, object, method: 'llm', ...extra }).id;
  return { db, sdk, entity, claim };
}

const rule = (id: string, body: Rule['body'], head: Rule['head']): Rule => ({ id, description: id, body, head });

describe('rule evaluator', () => {
  it('stratifies negation and refuses negation inside recursion and unsafe rules', () => {
    const strata = stratify([rule('a', [{ predicate: 'P', args: ['?x', '?y'] }, { predicate: 'Q', args: ['?x', '?y'], negated: true }], { predicate: 'R', args: ['?x', '?y'] }),
      rule('b', [{ predicate: 'R', args: ['?x', '?y'] }], { predicate: 'S', args: ['?x', '?y'] })]);
    expect(strata.get('R')).toBe(1);
    expect(strata.get('S')).toBe(1);
    expect(() => stratify([rule('c', [{ predicate: 'P', args: ['?x', '?y'] }, { predicate: 'R', args: ['?x', '?y'], negated: true }], { predicate: 'R', args: ['?x', '?y'] })]))
      .toThrow('not stratifiable');
    const { db } = fixture();
    expect(() => evaluateRules(db, [rule('unsafe', [{ predicate: 'P', args: ['?x', '?y'] }], { predicate: 'R', args: ['?x', '?z'] })])).toThrow('unsafe');
  });

  it('derives INTERACTED_WITH from applications to offered opportunities, reading raw predicates and inverses', () => {
    const { db, sdk, entity, claim } = fixture();
    const me = entity('Ada Byron', 'Person'), job = entity('Rocket Internship', 'Opportunity'), acme = entity('Acme', 'Organization');
    const applied = claim(me, 'applied_for', job);
    const offered = claim(acme, 'offers', job);
    const result = evaluateRules(db, DEFAULT_RULES);
    expect(result.perRule).toEqual({ 'applied-offered': 1 });
    const [derivation] = result.derivations;
    expect(derivation).toMatchObject({ subject: me, predicate: 'INTERACTED_WITH', object: acme });
    expect(derivation!.dependsOn.sort()).toEqual([applied, offered].sort());
    expect(commitDerivations(db, sdk.graph, result.derivations)).toEqual({ created: 1, skipped: 0 });
    const written = sdk.graph.claims.get(derivationId(derivation!));
    expect(written).toMatchObject({ method: 'rule:applied-offered', status: 'proposed', predicate: 'INTERACTED_WITH' });
    expect(sdk.graph.lifecycle.inspect(written.id).dependencies.sort()).toEqual([applied, offered].sort());
    // Idempotent: the conclusion now holds as a fact, so it is not derived again.
    expect(evaluateRules(db, DEFAULT_RULES).derivations).toEqual([]);
    // Retracting a premise makes the conclusion stale through the dependency trigger.
    sdk.graph.lifecycle.review(applied, 'retracted', 'test', 'withdrawn');
    expect(sdk.graph.claims.get(written.id).status).toBe('stale');
  });

  it('closes PART_OF transitively over things, semi-naively, with validity intersection and bounds', () => {
    const { db, entity, claim } = fixture();
    const [a, b, c, d] = ['Unit A', 'Course B', 'Program C', 'School D'].map((name, index) => entity(name, ['Concept', 'Course', 'Opportunity', 'Organization'][index]!));
    claim(a!, 'PART_OF', b!, { validFrom: 0, validTo: 1000 });
    claim(b!, 'part_of', c!, { validFrom: 500 });
    claim(c!, 'PART_OF', d!);
    const result = evaluateRules(db, DEFAULT_RULES);
    const derived = result.derivations.map(item => [item.subject, item.object]);
    expect(derived).toContainEqual([a, c]);
    expect(derived).toContainEqual([b, d]);
    expect(derived).toContainEqual([a, d]);
    expect(result.derivations.find(item => item.subject === a && item.object === c)).toMatchObject({ validFrom: 500, validTo: 1000 });
    expect(evaluateRules(db, DEFAULT_RULES, { maxDerivations: 1 })).toMatchObject({ truncated: true });
    // Connector containers are not things: a message in a conversation in a server is not closed over.
    const message = entity('msg', 'Conversation'), server = entity('Guild', 'Server');
    claim(message, 'PART_OF', a!);
    claim(d!, 'PART_OF', server);
    expect(evaluateRules(db, DEFAULT_RULES).derivations.some(item => item.subject === message || item.object === server)).toBe(false);
  });

  it('affiliates people with an organization through its mail domain once two people corroborate it', () => {
    expect(abbreviates('uwaterloo', 'University of Waterloo')).toBe(true);
    expect(abbreviates('umich', 'University of Michigan (Ann Arbor)')).toBe(true);
    expect(abbreviates('nyas', 'The New York Academy of Sciences')).toBe(true);
    expect(abbreviates('lumiere', 'Lumiere Education')).toBe(false);
    expect(abbreviates('google', 'Google Events')).toBe(false);
    expect(personLike('Rita Bhowmik <r2bhowmik@uwaterloo.ca>')).toBe(true);
    for (const mailbox of ['Michigan Admissions', 'IT Accounts', 'CCIR Schedule', 'helpdesk@uwaterloo.ca', 'University of Waterloo'])
      expect(personLike(mailbox)).toBe(false);

    const { db, sdk, entity } = fixture();
    const person = (name: string, address: string) => {
      const id = entity(`${name} <${address}>`, 'Person');
      sdk.graph.entities.addAlias(id, `email:user:${address}`, 'connector-key');
      return id;
    };
    const uw = entity('University of Waterloo', 'Organization');
    const rita = person('Rita Bhowmik', 'r2bhowmik@uwaterloo.ca'), sam = person('Sam Okafor', 'sokafor@uwaterloo.ca');
    person('Registrar Office', 'registrar@uwaterloo.ca');
    person('Noreply Bot', 'no-reply@uwaterloo.ca');
    const lone = person('Lena Park', 'lpark@acme.io');
    entity('Acme', 'Organization');
    const friends = [person('Jo Free', 'jo@gmail.com'), person('Al Free', 'al@gmail.com')];
    const facts = affiliationFacts(db);
    expect(facts.get('@EMAIL_DOMAIN')!.map(fact => fact.s).sort()).toEqual([rita, sam, lone].sort());
    expect(facts.get('@ORG_DOMAIN')).toContainEqual(expect.objectContaining({ s: uw, o: 'uwaterloo.ca' }));
    const result = evaluateRules(db, DEFAULT_RULES, { extraFacts: facts });
    const affiliations = result.derivations.filter(item => item.ruleId === 'email-domain-affiliation');
    expect(affiliations.map(item => [item.subject, item.object]).sort()).toEqual([[rita, uw], [sam, uw]].sort());
    expect(affiliations[0]!.qualifiers).toMatchObject({ d: 'uwaterloo.ca', corroborators: 2 });
    expect(affiliations.flatMap(item => [item.subject])).not.toContain(lone);
    expect(affiliations.flatMap(item => [item.subject])).not.toContain(friends[0]);
    // A stated relation already says it: negation keeps the rule from repeating it.
    sdk.graph.claims.add({ subject: rita, predicate: 'works_at', object: uw, method: 'llm' });
    expect(evaluateRules(db, DEFAULT_RULES, { extraFacts: affiliationFacts(db) }).derivations.map(item => item.subject)).not.toContain(rita);
  });

  it('links functional-property disagreements between sources as contradictions without deleting anything', () => {
    const { db, sdk, entity } = fixture();
    const job = entity('Rocket Internship', 'Opportunity'), promo = entity('SAVE20', 'Concept');
    const source = (id: string, text: string) => {
      sdk.ingest.sourceAndChunks({ source: { id, uri: `mail://${id}`, title: id, origin: 'email', type: 'email', hash: `${id}-v1` }, chunks: [{ text_content: text }] });
    };
    source('a', 'Applications close October 15, 2026.');
    source('b', 'Applications close November 1, 2026.');
    source('c', 'Reminder: applications close October 15, 2026.');
    const value = (subject: number, predicate: string, date: string, sourceId: string) =>
      sdk.graph.claims.add({ subject, predicate, value: date, method: 'llm', evidence: [{ sourceId }] }).id;
    const first = value(job, 'application_deadline', 'October 15, 2026', 'a');
    const second = value(job, 'deadline', 'Nov 1, 2026', 'b');
    value(job, 'deadline', '2026-10-15', 'c');
    value(job, 'early_deadline', 'September 1, 2026', 'c');
    // Recurring things legitimately have many end dates.
    value(promo, 'expires', 'June 1, 2026', 'a');
    value(promo, 'expires', 'July 1, 2026', 'b');
    const conflicts = functionalConflicts(db);
    expect(conflicts.map(conflict => conflict.predicate)).toEqual(['HAS_DEADLINE', 'HAS_DEADLINE']);
    expect(conflicts.flatMap(conflict => [conflict.a, conflict.b])).toContain(second);
    expect(conflicts.some(conflict => [conflict.a, conflict.b].includes(first))).toBe(true);
    expect(linkConflicts(db, conflicts)).toBe(2);
    expect(linkConflicts(db, conflicts)).toBe(0);
    expect(sdk.graph.conflicts.find().conflicts.filter(conflict => conflict.reason === 'Explicit contradiction')).toHaveLength(2);
    expect(sdk.graph.claims.get(first).status).toBe('proposed');
  });
});
