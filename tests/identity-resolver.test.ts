import { afterEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { IdentityResolver, SELF_STABLE_ID } from '../sdk/graph/identity';
import { canonicalOf, rebuildRegistry, shortlist } from '../sdk/graph/registry';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = createTestDatabase(); databases.push(db);
  const sdk = createExtensionSDK('knowledge-graph', { database: db, namespace: 'knowledge' });
  const resolver = new IdentityResolver(db, sdk.graph);
  const connector = (namespace: string, key: string, name: string, type: string) => {
    const entity = sdk.graph.entities.create({ stableId: `${namespace}:${key}`, name, type, namespace });
    sdk.graph.entities.addAlias(entity.id, key, 'connector-key');
    return entity.id;
  };
  const mention = (source: string, name: string, type: string) =>
    sdk.graph.entities.create({ stableId: `extracted:${source}:${type}:${name}`, name, type, namespace: 'knowledge' }).id;
  return { db, sdk, resolver, connector, mention };
}

describe('identity resolver', () => {
  it('merges mentions that share a strong key for their family and links pages and communities across families', () => {
    const { db, sdk, resolver, connector, mention } = fixture();
    const server = connector('discord', 'discord://guild/147', 'UWHPC', 'Server');
    const page = connector('browser', 'https://github.com/zeiteigen/onboarding-template', 'zeiteigen/onboarding-template', 'WebPage');
    expect(resolver.keyConnectorEntities().keyed).toBe(2);

    const org = mention('web:1', 'UWHPC', 'Organization');
    expect(resolver.resolveMention({ entityId: org, type: 'Organization', names: ['UWHPC'], urls: ['https://github.com/UWHPC'] }).outcome).toBe('new');
    const fromEmail = mention('email:1', 'University of Waterloo High Performance Computing', 'Organization');
    // Same acronym, but only a weak key: queued for adjudication instead of merged.
    expect(resolver.resolveMention({ entityId: fromEmail, type: 'Organization',
      names: ['University of Waterloo High Performance Computing', 'UW HPC Club'] }))
      .toMatchObject({ outcome: 'queued', canonicalId: fromEmail });
    const fromRepo = mention('web:2', 'UWHPC org', 'Organization');
    expect(resolver.resolveMention({ entityId: fromRepo, type: 'Organization', names: ['UWHPC org'],
      urls: ['https://github.com/UWHPC/onboarding-template'] })).toMatchObject({ outcome: 'merged', canonicalId: org });

    const repo = mention('web:1', 'zeiteigen/onboarding-template', 'Artifact');
    resolver.resolveMention({ entityId: repo, type: 'Artifact', names: ['onboarding-template'],
      urls: ['https://github.com/zeiteigen/onboarding-template'] });
    const links = (predicate: string) => db.query<{ s: number; o: number; status: string }, [string]>(
      'SELECT subject_id AS s,object_id AS o,status FROM graph_claims WHERE predicate=?').all(predicate);
    expect(links('REFERS_TO')).toContainEqual({ s: page, o: repo, status: 'accepted' });
    expect(links('COMMUNITY_OF')).toContainEqual({ s: server, o: org, status: 'accepted' });

    // A model verdict closes the queued pair; merges are reversible.
    resolver.decide(fromEmail, org, 'same', 0.92, 'Expansion of the acronym');
    expect(canonicalOf(db, fromEmail)).toBe(org);
    const change = sdk.graph.entities.inspect(fromEmail).merges[0]!.id;
    sdk.graph.entities.unmerge(change);
    expect(canonicalOf(db, fromEmail)).toBe(fromEmail);
  });

  it('merges a model registry match only with key support, and never people by name alone', () => {
    const { resolver, mention, db } = fixture();
    const first = mention('a', 'Shale', 'Project');
    resolver.resolveMention({ entityId: first, type: 'Project', names: ['Shale'] });
    const second = mention('b', 'shale', 'Project');
    expect(resolver.resolveMention({ entityId: second, type: 'Project', names: ['shale'], match: first }).outcome).toBe('merged');
    const unrelated = mention('c', 'Knowledge app', 'Project');
    expect(resolver.resolveMention({ entityId: unrelated, type: 'Project', names: ['Knowledge app'], match: first }).outcome).toBe('queued');
    const alice = mention('a', 'Alice Chen', 'Person');
    resolver.resolveMention({ entityId: alice, type: 'Person', names: ['Alice Chen'] });
    const alice2 = mention('b', 'Alice Chen', 'Person');
    expect(resolver.resolveMention({ entityId: alice2, type: 'Person', names: ['Alice Chen'], match: alice }).outcome).toBe('queued');
    expect(canonicalOf(db, alice2)).toBe(alice2);
  });

  it('gathers the user accounts into the self identity', () => {
    const { db, resolver, connector } = fixture();
    const discord = connector('discord', 'discord:user:42', 'zeit', 'Person');
    const email = connector('email', 'email:user:me@example.test', 'Ali', 'Person');
    const other = connector('email', 'email:user:other@example.test', 'Ali', 'Person');
    resolver.keyConnectorEntities();
    const self = resolver.ensureSelf({ names: ['Ali Shahzad'], emails: ['me@example.test'], discordIds: ['42'], handles: ['github:zeiteigen'] });
    expect(db.query('SELECT stable_id FROM entities WHERE id=?').get(self)).toEqual({ stable_id: SELF_STABLE_ID });
    expect(canonicalOf(db, discord)).toBe(self);
    expect(canonicalOf(db, email)).toBe(self);
    expect(canonicalOf(db, other)).toBe(other);
    // Idempotent.
    expect(resolver.ensureSelf({ names: ['Ali Shahzad'], emails: ['me@example.test'] })).toBe(self);
  });

  it('shortlists registry entries by key and by rare terms', () => {
    const { db, resolver, mention, sdk } = fixture();
    const org = mention('a', 'UWHPC', 'Organization');
    resolver.resolveMention({ entityId: org, type: 'Organization', names: ['UWHPC'] });
    sdk.graph.claims.add({ subject: org, predicate: 'DESCRIPTION', value: 'Waterloo high performance computing student club', method: 'llm' });
    const other = mention('b', 'Waterloo Rocketry', 'Organization');
    resolver.resolveMention({ entityId: other, type: 'Organization', names: ['Waterloo Rocketry'] });
    rebuildRegistry(db);
    expect(shortlist(db, { texts: ['Interview invitation from the UWHPC team at Waterloo'] }).map(entry => entry.id)[0]).toBe(org);
    expect(shortlist(db, { keys: [{ kind: 'name', value: 'uwhpc' }] })).toMatchObject([{ id: org, basis: ['name:uwhpc'] }]);
    expect(shortlist(db, { texts: ['high performance computing'] })[0]).toMatchObject({ id: org,
      description: 'Waterloo high performance computing student club' });
  });
});
