import { afterEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { canonicalPredicate, fits, PREDICATES, PREDICATE_NAMES, predicatePrompt, predicateTokens, registerPredicates } from '../lib/graph/predicates';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

test('lemmatises snake, camel, spaced, and inflected predicates', () => {
  expect(predicateTokens('sentEmailTo')).toEqual(['send', 'email', 'to']);
  expect(predicateTokens('is located at')).toEqual(['locate', 'at']);
  expect(predicateTokens('APPLIED_TO')).toEqual(['apply', 'to']);
  expect(predicateTokens('offers_internship')).toEqual(['offer', 'internship']);
});

test('maps frequent production predicates onto typed relations within domain and range', () => {
  const cases: Array<[string, string | undefined, string | null | undefined, string]> = [
    ['works_for', 'Person', 'Organization', 'WORKS_AT'],
    ['is_student_at', 'Person', 'Organization', 'STUDIES_AT'],
    ['applied_to', 'Person', 'Opportunity', 'APPLIED_TO'],
    ['employer', 'Opportunity', 'Organization', 'OFFERED_BY'],
    ['posted_by', 'Opportunity', 'Organization', 'OFFERED_BY'],
    ['posted_by', 'Artifact', 'Person', 'AUTHORED_BY'],
    ['sent_email_to', 'Organization', 'Person', 'SENT_TO'],
    ['closes', 'Opportunity', null, 'HAS_DEADLINE'],
    ['application_deadline', 'Opportunity', null, 'HAS_DEADLINE'],
    ['ends', 'Event', null, 'ENDS_ON'],
    ['scheduled_date', 'Event', null, 'SCHEDULED_FOR'],
    ['occurs on', 'Event', null, 'SCHEDULED_FOR'],
    ['located_at', 'Organization', null, 'LOCATED_IN'],
    ['registered_office', 'Organization', 'Place', 'LOCATED_IN'],
    ['company_number', 'Organization', null, 'HAS_IDENTIFIER'],
    ['has_email', 'Person', null, 'HAS_CONTACT'],
    ['has_deadline', 'Opportunity', null, 'HAS_DEADLINE'],
    ['is a', 'Concept', 'Concept', 'INSTANCE_OF'],
    ['RECOMMENDS', 'Person', 'Product', 'RECOMMENDS'],
    ['hosted_by', 'Event', 'Organization', 'ORGANIZED_BY'],
    ['EMPLOYS', 'Organization', 'Person', 'EMPLOYS'],
  ];
  for (const [raw, subject, object, expected] of cases)
    expect([raw, canonicalPredicate(raw, subject, object).predicate]).toEqual([raw, expected]);
  expect(canonicalPredicate('WORKS_AT', 'Person', 'Organization')).toMatchObject({ basis: 'schema', confidence: 1 });
});

test('falls back to RELATED_TO with the wording as label when types or meaning do not fit', () => {
  // WORKS_AT needs a person working at an organization.
  expect(canonicalPredicate('works_for', 'Organization', 'Organization')).toMatchObject({ predicate: 'RELATED_TO', label: 'works_for' });
  // Negated wording must not become its positive relation.
  expect(canonicalPredicate('was_not_admitted_to', 'Person', 'Organization')).toMatchObject({ predicate: 'RELATED_TO', label: 'was_not_admitted_to' });
  expect(canonicalPredicate('has_chemical_formula_weirdness', 'Concept', 'Person').predicate).toBe('RELATED_TO');
  // An exact schema name with the wrong types is not trusted either.
  expect(canonicalPredicate('APPLIED_TO', 'Organization', 'Opportunity').predicate).not.toBe('APPLIED_TO');
  // Code-written predicates pass through untouched.
  for (const system of ['MENTIONS_ENTITY', 'SUMMARY', 'DESCRIPTION', 'ROLE:participant', 'PART_OF_EPISODE'])
    expect(canonicalPredicate(system, 'Person', 'Event')).toMatchObject({ predicate: system, basis: 'system' });
});

test('domain and range checks treat connector and unknown types leniently and literals strictly', () => {
  const worksAt = PREDICATES.find(definition => definition.name === 'WORKS_AT')!;
  expect(fits(worksAt, 'EmailAddress', 'Organization')).toBe(true); // EmailAddress is a Person-family connector type
  expect(fits(worksAt, 'ChatSession', 'Organization')).toBe(true); // unverifiable subject
  expect(fits(worksAt, 'Person', null)).toBe(false); // a literal is not an organization
  expect(fits(PREDICATES.find(definition => definition.name === 'HAS_DEADLINE')!, 'Opportunity', null)).toBe(true);
});

test('declares names, inverses, and transitivity without type constraints that could abort commits', () => {
  const db = createTestDatabase(); databases.push(db);
  const sdk = createExtensionSDK('knowledge-extractor', { database: db, namespace: 'knowledge' });
  const person = sdk.graph.entities.create({ name: 'Ada', type: 'EmailAddress' });
  const org = sdk.graph.entities.create({ name: 'Acme', type: 'Organization' });
  // A live claim whose subject type the schema's domain would reject.
  sdk.graph.claims.add({ subject: person.id, predicate: 'WORKS_AT', object: org.id, status: 'accepted', method: 'manual' });
  registerPredicates(sdk.graph.relations);
  registerPredicates(sdk.graph.relations); // idempotent
  expect(sdk.graph.relations.get('WORKS_AT')).toMatchObject({ name: 'WORKS_AT', inverse: 'EMPLOYS' });
  expect(sdk.graph.relations.get('WORKS_AT')?.sourceTypes).toBeUndefined();
  expect(sdk.graph.relations.reciprocal('EMPLOYS')).toBe('WORKS_AT');
  expect(sdk.graph.relations.get('LOCATED_IN')?.transitive).toBe(true);
  expect(sdk.graph.relations.reciprocal('RELATED_TO')).toBe('RELATED_TO');
  // Built-in definitions are left alone.
  expect(sdk.graph.relations.get('PART_OF')).toMatchObject({ inverse: 'HAS_PART', transitive: true });
  sdk.graph.claims.add({ subject: person.id, predicate: 'WORKS_AT', object: org.id, status: 'proposed', method: 'manual' });
});

test('the prompt enum lists every schema predicate and the RELATED_TO fallback', () => {
  const prompt = predicatePrompt();
  for (const definition of PREDICATES) expect(prompt).toContain(`${definition.name} (`);
  expect(PREDICATE_NAMES.has('RELATED_TO')).toBe(true);
  expect(PREDICATES.length).toBeGreaterThanOrEqual(35);
});
