import { afterEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { Gazetteer, gazetteerFor, surfaceEntry, tokenize, type GazetteerEntry } from '../lib/graph/gazetteer';
import { indexEntity } from '../sdk/graph/registry';
import { detectMentions, typeMention } from '../lib/graph/mention-typing';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const entry = (entityId: number, type: string, surface: string, kind: GazetteerEntry['kind'] = 'name') => surfaceEntry(entityId, type, surface, kind)!;

test('matches whole words with exact original spans, preferring the longest surface', () => {
  const gazetteer = new Gazetteer([entry(1, 'Organization', 'Northbridge'), entry(2, 'Organization', 'Northbridge High Performance Computing'),
    entry(3, 'Project', 'Atlas'), entry(4, 'Organization', 'Université de Montréal')]);
  const text = 'Joined Northbridge High Performance Computing; Atlassian is not Atlas. Northbridge again. UNIVERSITE de montreal too.';
  const matches = gazetteer.match(text);
  expect(matches.map(match => [match.entityId, match.quote])).toEqual([[2, 'Northbridge High Performance Computing'], [3, 'Atlas'], [1, 'Northbridge'],
    [4, 'UNIVERSITE de montreal']]);
  for (const match of matches) expect(text.slice(match.start, match.end)).toBe(match.quote);
});

test('acronyms match only in capitals and common words or tiny forms are never surfaces', () => {
  const gazetteer = new Gazetteer([entry(1, 'Organization', 'nhpc', 'acronym'), entry(2, 'Organization', 'AI')]);
  expect(gazetteer.match('NHPC onboarding with AI').map(match => match.entityId)).toEqual([1, 2]);
  expect(gazetteer.match('nhpc lower case and ai').map(match => match.entityId)).toEqual([]);
  expect(surfaceEntry(5, 'Event', 'Meeting', 'name')).toBeNull();
  expect(surfaceEntry(5, 'Product', 'The Team', 'name')).toBeNull();
  expect(surfaceEntry(5, 'Product', 'network', 'name')).toBeNull();
  expect(surfaceEntry(5, 'Product', 'Resume', 'alias')).toBeNull();
  expect(surfaceEntry(5, 'Event', 'June 1, 2026', 'name')).toBeNull();
  expect(surfaceEntry(5, 'Opportunity', 'SUMMER15', 'alias')).not.toBeNull();
  // One-word names must look like names where they occur.
  const notion = new Gazetteer([entry(9, 'Product', 'Notion')]);
  expect(notion.match('I had a notion. Notion is an app.').map(match => match.quote)).toEqual(['Notion']);
});

test('addresses, links, and markup boundaries never produce name matches', () => {
  const gazetteer = new Gazetteer([entry(1, 'Organization', 'Lenovo'), entry(2, 'Organization', 'Acme Labs')]);
  expect(gazetteer.match('Write to deals@lenovo.com or see https://lenovo.com/x and lenovo.com').map(match => match.quote)).toEqual([]);
  expect(gazetteer.match('Acme <Labs>').length).toBe(0);
  expect(gazetteer.match('Acme Labs, Lenovo').map(match => match.entityId)).toEqual([2, 1]);
});

test('ambiguous surfaces are resolved by graph context and dropped on a tie', () => {
  const gazetteer = new Gazetteer([entry(1, 'Organization', 'ACM'), entry(2, 'Organization', 'ACM'), entry(3, 'Organization', 'Waterloo University'),
    entry(10, 'Person', 'Alex'), entry(11, 'Person', 'Alex')]);
  const neighbours = () => new Map([[1, new Set([3])], [2, new Set([99])], [10, new Set<number>()], [11, new Set<number>()]]);
  const linked = gazetteer.match('The ACM chapter at Waterloo University', { neighbours });
  expect(linked.map(match => [match.entityId, match.basis, match.candidates])).toEqual([[1, 'context', [1, 2]], [3, 'unique', [3]]]);
  expect(gazetteer.match('The ACM chapter', { neighbours }).map(match => match.entityId)).toEqual([]);
  // A lone first name needs the participants to say which person it is.
  expect(gazetteer.match('Alex said hi', { neighbours }).length).toBe(0);
  expect(gazetteer.match('Alex said hi', { neighbours, context: [11] }).map(match => match.entityId)).toEqual([11]);
});

test('builds from the registry and rebuilds only when the registry changes', () => {
  const db = createTestDatabase(); databases.push(db);
  const sdk = createExtensionSDK('knowledge-extractor', { database: db, namespace: 'knowledge' });
  const org = sdk.graph.entities.create({ name: 'Northbridge High Performance Computing', type: 'Organization' });
  sdk.graph.entities.addAlias(org.id, 'nhpc', 'key:acronym');
  sdk.graph.entities.addAlias(org.id, 'Northbridge HPC', 'search');
  indexEntity(db, org.id);
  const first = gazetteerFor(db);
  expect(gazetteerFor(db)).toBe(first);
  expect(first.match('Joined NHPC and Northbridge HPC').map(match => [match.entityId, match.kind])).toEqual([[org.id, 'acronym'], [org.id, 'alias']]);
  const merged = sdk.graph.entities.create({ name: 'Lumiere Education', type: 'Organization' });
  indexEntity(db, merged.id);
  const second = gazetteerFor(db);
  expect(second).not.toBe(first);
  expect(second.match('Lumiere Education').map(match => match.entityId)).toEqual([merged.id]);
  expect(tokenize('AT&T Café').map(token => token.norm)).toEqual(['at&t', 'cafe']);
});

test('types new mentions by head noun, suffix, and course code, and returns null otherwise', () => {
  expect(typeMention('University of Waterloo')).toBe('Organization');
  expect(typeMention('Acme Robotics Inc')).toBe('Organization');
  expect(typeMention('Lumiere Research Scholar Program')).toBe('Opportunity');
  expect(typeMention('Pearl Sullivan Scholarship')).toBe('Opportunity');
  expect(typeMention('Hack the North Hackathon')).toBe('Event');
  expect(typeMention('Global AI Summit')).toBe('Event');
  expect(typeMention('CS 136')).toBe('Course');
  expect(typeMention('MATH137')).toBe('Course');
  expect(typeMention('Design Doc')).toBe('Artifact');
  expect(typeMention('Jane Doe')).toBeNull();
  expect(typeMention('Machine Learning')).toBeNull();
  expect(typeMention('COVID 19')).toBeNull();
  const mentions = detectMentions('From: Jane Doe <jane@uni.edu>\nHi Jane, the Pearl Sullivan Scholarship closes soon. Take CS 136 at the University of Waterloo. Repo: https://github.com/acme/atlas');
  const byName = Object.fromEntries(mentions.map(mention => [mention.name, mention]));
  expect(byName['Jane Doe']).toMatchObject({ type: 'Person', kind: 'email', url: 'jane@uni.edu' });
  expect(byName['Pearl Sullivan Scholarship']?.type).toBe('Opportunity');
  expect(byName['CS 136']?.type).toBe('Course');
  expect(byName['University of Waterloo']?.type).toBe('Organization');
  expect(byName['acme/atlas']).toMatchObject({ type: 'Artifact', kind: 'url' });
  expect(mentions.some(mention => mention.name === 'Hi Jane')).toBe(false);
});
