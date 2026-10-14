import { afterEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { IdentityResolver, SELF_STABLE_ID } from '../sdk/graph/identity';
import { canonicalOf, rebuildRegistry, shortlist } from '../sdk/graph/registry';
import { adjudicate, settleExact } from '../extensions/knowledge-graph/resolve';

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
    const server = connector('discord', 'discord://guild/147', 'NHPC', 'Server');
    const page = connector('browser', 'https://github.com/example-user/onboarding-template', 'example-user/onboarding-template', 'WebPage');
    expect(resolver.keyConnectorEntities().keyed).toBe(2);

    const org = mention('web:1', 'NHPC', 'Organization');
    expect(resolver.resolveMention({ entityId: org, type: 'Organization', names: ['NHPC'], urls: ['https://github.com/NHPC'] }).outcome).toBe('new');
    const fromEmail = mention('email:1', 'Northbridge High Performance Computing', 'Organization');
    // Same acronym, but only a weak key: queued for adjudication instead of merged.
    expect(resolver.resolveMention({ entityId: fromEmail, type: 'Organization',
      names: ['Northbridge High Performance Computing', 'NH PC Club'] }))
      .toMatchObject({ outcome: 'queued', canonicalId: fromEmail });
    const fromRepo = mention('web:2', 'NHPC org', 'Organization');
    expect(resolver.resolveMention({ entityId: fromRepo, type: 'Organization', names: ['NHPC org'],
      urls: ['https://github.com/NHPC/onboarding-template'] })).toMatchObject({ outcome: 'merged', canonicalId: org });

    const repo = mention('web:1', 'example-user/onboarding-template', 'Artifact');
    resolver.resolveMention({ entityId: repo, type: 'Artifact', names: ['onboarding-template'],
      urls: ['https://github.com/example-user/onboarding-template'] });
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
    const discord = connector('discord', 'discord:user:42', 'example-user', 'Person');
    const email = connector('email', 'email:user:me@example.test', 'Alex', 'Person');
    const other = connector('email', 'email:user:other@example.test', 'Alex', 'Person');
    resolver.keyConnectorEntities();
    const self = resolver.ensureSelf({ names: ['Alex Morgan'], emails: ['me@example.test'], discordIds: ['42'], handles: ['github:example-user'] });
    expect(db.query('SELECT stable_id FROM entities WHERE id=?').get(self)).toEqual({ stable_id: SELF_STABLE_ID });
    expect(canonicalOf(db, discord)).toBe(self);
    expect(canonicalOf(db, email)).toBe(self);
    expect(canonicalOf(db, other)).toBe(other);
    // Idempotent.
    expect(resolver.ensureSelf({ names: ['Alex Morgan'], emails: ['me@example.test'] })).toBe(self);
  });

  it('shortlists registry entries by key and by rare terms', () => {
    const { db, resolver, mention, sdk } = fixture();
    const org = mention('a', 'NHPC', 'Organization');
    resolver.resolveMention({ entityId: org, type: 'Organization', names: ['NHPC'] });
    sdk.graph.claims.add({ subject: org, predicate: 'DESCRIPTION', value: 'Northbridge high performance computing student club', method: 'llm' });
    const other = mention('b', 'Northbridge Rocketry', 'Organization');
    resolver.resolveMention({ entityId: other, type: 'Organization', names: ['Northbridge Rocketry'] });
    rebuildRegistry(db);
    expect(shortlist(db, { texts: ['Interview invitation from the NHPC team at Northbridge'] }).map(entry => entry.id)[0]).toBe(org);
    expect(shortlist(db, { keys: [{ kind: 'name', value: 'nhpc' }] })).toMatchObject([{ id: org, basis: ['name:nhpc'] }]);
    expect(shortlist(db, { texts: ['high performance computing'] })[0]).toMatchObject({ id: org,
      description: 'Northbridge high performance computing student club' });
  });

  it('merges exact names of one thing without the model, but not people, partial names, or separated identities', async () => {
    const { db, sdk, resolver, mention } = fixture();
    const course = mention('a', 'IB DP Global Politics', 'Course');
    resolver.resolveMention({ entityId: course, type: 'Course', names: ['IB DP Global Politics', 'Global Politics'] });
    sdk.graph.entities.addAlias(course, 'Global Politics', 'search');
    const later = mention('b', 'Global Politics', 'Course');
    expect(resolver.resolveMention({ entityId: later, type: 'Course', names: ['global-politics'] }))
      .toMatchObject({ outcome: 'merged', canonicalId: course });
    expect(db.query<{ reason: string }, []>('SELECT reason FROM graph_identity_changes').get()!.reason).toStartWith('Exact name match');
    // A concept of the same name is a different kind of thing.
    const concept = mention('c', 'Global Politics', 'Concept');
    expect(resolver.resolveMention({ entityId: concept, type: 'Concept', names: ['Global Politics'] }).outcome).toBe('new');

    const company = mention('a', 'Cloudflare', 'Organization');
    resolver.resolveMention({ entityId: company, type: 'Organization', names: ['Cloudflare'] });
    const forum = mention('b', 'Cloudflare Community', 'Organization');
    expect(resolver.resolveMention({ entityId: forum, type: 'Organization', names: ['Cloudflare Community'] }).outcome).toBe('queued');

    // Two things the model told apart make their shared name ambiguous.
    const first = mention('a', 'Atlas', 'Project'), second = mention('b', 'Atlas', 'Project');
    resolver.resolveMention({ entityId: first, type: 'Project', names: ['Atlas'] });
    resolver.resolveMention({ entityId: second, type: 'Project', names: ['Atlas'] });
    expect(canonicalOf(db, second)).toBe(first);
    sdk.graph.entities.unmerge(sdk.graph.entities.inspect(second).merges[0]!.id);
    const third = mention('c', 'Atlas', 'Project');
    expect(resolver.resolveMention({ entityId: third, type: 'Project', names: ['Atlas'] }).outcome).toBe('queued');

    // Queued exact-name pairs are settled without a model request; people still go to the model.
    const alice = mention('a', 'Alice Chen', 'Person'), alice2 = mention('b', 'Alice Chen', 'Person');
    resolver.resolveMention({ entityId: alice, type: 'Person', names: ['Alice Chen'] });
    expect(resolver.resolveMention({ entityId: alice2, type: 'Person', names: ['Alice Chen'] }).outcome).toBe('queued');
    // A pair queued before this rule existed (names keyed, no decision yet).
    const place = mention('a', 'Lahore', 'Place'), place2 = mention('b', 'Lahore', 'Place');
    for (const id of [place, place2]) sdk.graph.entities.addAlias(id, 'lahore', 'key:name');
    db.query("INSERT INTO graph_resolution_queue(mention_id,candidate_id,basis,created_at) VALUES(?,?,'duplicate-sweep',1)").run(place2, place);
    expect(settleExact(resolver)).toBe(1);
    expect(canonicalOf(db, place2)).toBe(place);
    const prompts: string[] = [];
    sdk.queryLLM = (async (prompt: string) => { prompts.push(prompt); return '{"decisions":[]}'; }) as typeof sdk.queryLLM;
    await adjudicate(sdk, resolver, 32);
    expect(prompts.join('\n')).toContain('Alice Chen');
    expect(prompts.join('\n')).not.toContain('Lahore');
  });
});
