import { afterEach, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { ensureStorySchema } from '../lib/graph/story-schema';
import { Assigner, DEFAULTS, assign, idf, pendingDigests, recordSignals } from '../extensions/episodes/assign';
import { indexEntity, shortlist } from '../sdk/graph/registry';
import { EpisodeStore } from '../sdk/graph/episodes';
import { consolidate, mergeCandidates } from '../extensions/episodes/consolidate';
import { reconsiderContext } from '../extensions/episodes/reconsider';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const DAY = 86_400_000;

function fixture() {
  const db = createTestDatabase(); databases.push(db);
  ensureStorySchema(db);
  const sdk = createExtensionSDK('episodes', { database: db, namespace: 'episodes' });
  const entity = (name: string, type = 'Organization') => sdk.graph.entities.create({ stableId: `t:${name}`, name, type, namespace: 'knowledge' }).id;
  const digest = (id: string, at: number, entities: number[], involvement = 'participant', activity: unknown = null) => {
    sdk.ingest.sourceAndChunks({ source: { id, uri: `test://${id}`, title: id, origin: 'test', type: 'note', hash: id, created_at: at, updated_at: at },
      chunks: [{ text_content: `Source ${id}` }] });
    db.query(`INSERT INTO graph_source_digests(source_id,revision_id,digested_at,summary,involvement,activity,entity_ids,occurred_from,occurred_to)
      VALUES(?,(SELECT id FROM graph_source_revisions WHERE source_id=?),?,?,?,?,?,?,?)`).run(id, id, at, `${id} happened.`, involvement,
      activity ? JSON.stringify(activity) : null, JSON.stringify(entities), at, at);
  };
  return { db, sdk, entity, digest };
}

it('weighs rare entities over common ones and ignores ubiquitous ones', () => {
  const { sdk, entity, digest } = fixture();
  const common = entity('Discord'), rare = entity('UWHPC');
  for (let index = 0; index < 30; index++) digest(`s${index}`, index * DAY, index < 2 ? [common, rare] : [common]);
  recordSignals(sdk);
  expect(idf(sdk, rare, 30)).toBeGreaterThan(2.5);
  expect(idf(sdk, common, 30)).toBe(0);
  const store = new EpisodeStore(sdk.database, sdk.graph);
  store.involve(store.create({ title: 'Unrelated organization activity', kind: 'other', at: DAY }), common, 1);
  sdk.database.run("UPDATE graph_source_digests SET episode_state='none',episode_checked_at=1");
  expect(reconsiderContext(sdk, 45)).toBe(0);
});

it('starts episodes only for the user, attaches clear matches, and reviews the middle band', () => {
  const { sdk, entity, digest } = fixture();
  const org = entity('UWHPC'), other = entity('Waterloo Rocketry');
  for (let index = 0; index < 20; index++) digest(`filler${index}`, index * DAY, [entity(`Filler ${index}`)], 'none');
  digest('start', 100 * DAY, [org], 'participant', { label: 'UWHPC onboarding', kind: 'application' });
  digest('progress', 101 * DAY, [org], 'author', { label: 'UWHPC onboarding', kind: 'application', stage: 'submitted' });
  digest('bystander', 102 * DAY, [org], 'none');
  digest('unrelated', 103 * DAY, [other], 'observer');
  digest('aside', 104 * DAY, [other], 'participant');
  recordSignals(sdk);
  const assigner = new Assigner(sdk, { ...DEFAULTS, attachScore: 2, reviewScore: 1 });
  const decisions = new Map(pendingDigests(sdk, 100).map(row => [row.source_id, assigner.decide(row)]));
  const store = new EpisodeStore(sdk.database, sdk.graph);
  const [episode] = store.list();
  expect(store.list()).toHaveLength(1);
  expect(store.get(episode!.id)!.members.map(member => [member.sourceId, member.role])).toEqual([['start', 'trigger'], ['progress', 'progress']]);
  // A bystander scoring between attachScore and 1.5x of it goes to the model instead of joining directly.
  expect(decisions.get('bystander')?.candidates[0]?.episode).toBe(episode!.id);
  const state = (id: string) => sdk.database.query<{ episode_state: string }, [string]>(
    'SELECT episode_state FROM graph_source_digests WHERE source_id=?').get(id)!.episode_state;
  expect(['unrelated', 'aside', 'filler0'].map(state)).toEqual(['none', 'none', 'none']);
});

it('adds columns introduced after the story tables first shipped', () => {
  const db = createTestDatabase(); databases.push(db);
  db.run('DROP TABLE IF EXISTS graph_source_digests');
  db.run(`CREATE TABLE graph_source_digests (source_id TEXT PRIMARY KEY, revision_id INTEGER NOT NULL, digested_at INTEGER NOT NULL,
    summary TEXT NOT NULL DEFAULT '', involvement TEXT NOT NULL DEFAULT 'none', activity TEXT, entity_ids TEXT NOT NULL DEFAULT '[]',
    occurred_from INTEGER, occurred_to INTEGER, model TEXT, episode_state TEXT NOT NULL DEFAULT 'pending') STRICT`);
  ensureStorySchema(db);
  const sdk = createExtensionSDK('episodes', { database: db, namespace: 'episodes' });
  expect(db.query<{ name: string }, []>('PRAGMA table_info(graph_source_digests)').all().map(row => row.name)).toContain('signals_at');
  expect(recordSignals(sdk)).toBe(0);
});

it('reviews a recurring organization before splitting its pursuit, while keeping generic platforms out of the lower band', () => {
  const { sdk, entity, digest } = fixture();
  const organization = entity('UWHPC'), platform = entity('GitHub', 'Product');
  for (let index = 0; index < 40; index++)
    digest(`background-${index}`, DAY, index < 17 ? [organization, platform] : [entity(`Other ${index}`)], 'none');
  digest('interview', 2 * DAY, [organization], 'participant', { label: 'UWHPC interview', kind: 'application' });
  digest('generic-visit', 2 * DAY, [platform], 'observer');
  recordSignals(sdk);
  const store = new EpisodeStore(sdk.database, sdk.graph);
  const onboarding = store.create({ title: 'UWHPC onboarding', kind: 'application', at: DAY });
  const unrelated = store.create({ title: 'Repository maintenance', kind: 'project', at: DAY });
  store.involve(onboarding, organization, 1); store.involve(unrelated, platform, 1);
  const assigner = new Assigner(sdk, DEFAULTS);
  const rows = new Map(pendingDigests(sdk, 100).map(row => [row.source_id, row]));
  const review = assigner.decide(rows.get('interview')!)!;
  expect(review.candidates[0].score).toBeLessThan(DEFAULTS.reviewScore);
  expect(review.candidates[0].episode).toBe(onboarding);
  expect(store.list()).toHaveLength(2);
  expect(assigner.decide(rows.get('generic-visit')!)).toBeNull();
  expect(sdk.database.query("SELECT episode_state FROM graph_source_digests WHERE source_id='generic-visit'").get())
    .toEqual({ episode_state: 'none' });
});

it('re-attaches a detached source, finds episodes by text among other registry entries, and frees stuck reviews', async () => {
  const { sdk, entity, digest } = fixture();
  digest('a', DAY, []);
  const store = new EpisodeStore(sdk.database, sdk.graph);
  const episode = store.create({ title: 'UWHPC onboarding', kind: 'application', at: DAY });
  const attach = () => store.attach(episode, 'a', { role: 'progress', step: 's', at: DAY, confidence: 1, status: 'accepted', basis: 't' });
  attach();
  store.detach(episode, 'a', 'test', 'wrong episode');
  expect(store.isMember(episode, 'a')).toBe(false);
  attach();
  expect(store.isMember(episode, 'a')).toBe(true);
  expect(store.ofSource('a')).toEqual([episode]);

  for (let index = 0; index < 30; index++) indexEntity(sdk.database, entity(`UWHPC member ${index}`, 'Person'));
  indexEntity(sdk.database, episode);
  expect(shortlist(sdk.database, { texts: ['UWHPC'], types: ['Episode'], limit: 5 }).map(entry => entry.id)).toEqual([episode]);

  sdk.database.run("UPDATE graph_source_digests SET episode_state='review' WHERE source_id='a'");
  await assign(sdk, DEFAULTS);
  expect(sdk.database.query("SELECT episode_state FROM graph_source_digests WHERE source_id='a'").get()).not.toEqual({ episode_state: 'review' });
});

it('reviews split pursuits across merged organization identities and reconsiders declines after new evidence', () => {
  const { sdk, entity, db } = fixture();
  const org = entity('UWHPC'), alias = entity('UWaterloo High Performance Computing'), platform = entity('GitHub', 'Product');
  const store = new EpisodeStore(db, sdk.graph);
  const first = store.create({ title: 'UWHPC onboarding', kind: 'application', at: DAY });
  const second = store.create({ title: 'UWHPC interview', kind: 'application', at: 2 * DAY });
  store.involve(first, alias, 1);
  sdk.graph.entities.merge(alias, org, 'Same club');
  store.involve(second, org, 1);
  for (let index = 0; index < 2; index++) store.involve(
    store.create({ title: `Unrelated GitHub activity ${index}`, kind: 'project', at: DAY }), platform, 1);
  expect(mergeCandidates(sdk)).toEqual([{ a: first, b: second, shared: 1 }]);
  sdk.state.set(`merge-declined:${first}:${second}`, 'previous verdict');
  expect(mergeCandidates(sdk)).toEqual([]);
  db.query('UPDATE graph_episodes SET updated_at=? WHERE entity_id=?').run(Date.now() + 1, second);
  expect(mergeCandidates(sdk)).toEqual([{ a: first, b: second, shared: 1 }]);
});

it('reconsiders unmatched context when a later source establishes the pursuit', async () => {
  const { sdk, entity, digest } = fixture();
  const org = entity('UWHPC');
  for (let index = 0; index < 20; index++) digest(`filler-${index}`, DAY, [entity(`Other ${index}`)], 'none');
  digest('announcement', DAY, [org], 'observer', { label: 'CCIR Application Process', kind: 'application' });
  await assign(sdk, DEFAULTS);
  expect(sdk.database.query("SELECT episode_state FROM graph_source_digests WHERE source_id='announcement'").get())
    .toEqual({ episode_state: 'none' });
  digest('application', 2 * DAY, [org], 'participant', { label: 'UWHPC onboarding', kind: 'application' });
  await assign(sdk, DEFAULTS);
  let reviewed = 0;
  sdk.queryLLM = (async () => { reviewed++; return JSON.stringify({ episode: 1, confidence: 0.9 }); }) as unknown as typeof sdk.queryLLM;
  await assign(sdk, DEFAULTS);
  expect(reviewed).toBe(1);
  const store = new EpisodeStore(sdk.database, sdk.graph);
  expect(store.get(store.list()[0].id)!.members.map(member => [member.sourceId, member.role]))
    .toEqual([['announcement', 'context'], ['application', 'trigger']]);
  expect(sdk.graph.entities.inspect(store.list()[0].id).aliases.map(alias => alias.alias)).not.toContain('CCIR Application Process');
  await assign(sdk, DEFAULTS);
  expect(reviewed).toBe(1);
});

it('unmerges episode membership, dates, involvement, and status without copied leftovers', () => {
  const { sdk, db, entity, digest } = fixture();
  digest('a', DAY, []); digest('b', 2 * DAY, []);
  const store = new EpisodeStore(db, sdk.graph);
  const first = store.create({ title: 'First', kind: 'project', at: DAY });
  const second = store.create({ title: 'Second', kind: 'project', at: 2 * DAY });
  for (const [id, sourceId, at] of [[first, 'a', DAY], [second, 'b', 2 * DAY]] as const)
    store.attach(id, sourceId, { role: 'progress', step: sourceId, at, confidence: 1, status: 'accepted', basis: 'test' });
  const org = entity('Second organization'); store.involve(second, org, 1);
  const change = store.merge(second, first, 'same pursuit');
  expect(store.get(first)!.members.map(member => member.sourceId)).toEqual(['a', 'b']);
  expect(store.get(first)!.lastActivityAt).toBe(2 * DAY);
  expect(store.list({ entityId: org }).map(episode => episode.id)).toEqual([first]);
  sdk.graph.entities.unmerge(change);
  expect(store.get(first)!.members.map(member => member.sourceId)).toEqual(['a']);
  expect(store.get(first)!.lastActivityAt).toBe(DAY);
  expect(store.list({ entityId: org }).map(episode => episode.id)).toEqual([second]);
  expect(store.get(second)!.status).toBe('active');
  expect(db.query('SELECT source_id FROM source_entities WHERE entity_id=?').all(first)).toEqual([{ source_id: 'a' }]);
});

it('retains narrative provenance until replacement and rejects a rewrite after membership changes', async () => {
  const { sdk, db, digest } = fixture();
  digest('a', DAY, []); digest('b', 2 * DAY, []);
  const store = new EpisodeStore(db, sdk.graph);
  const episode = store.create({ title: 'Details from b', kind: 'project', at: DAY });
  for (const sourceId of ['a', 'b']) store.attach(episode, sourceId,
    { role: 'progress', step: sourceId, at: DAY, confidence: 1, status: 'accepted', basis: 'test' });
  db.query('UPDATE graph_episodes SET summary=? WHERE entity_id=?').run('Details from b', episode);
  store.detach(episode, 'b', 'test', 'wrong member');
  expect(db.query('SELECT source_id FROM source_entities WHERE entity_id=? ORDER BY source_id').all(episode))
    .toEqual([{ source_id: 'a' }, { source_id: 'b' }]);
  sdk.queryLLM = (async (prompt: string) => {
    expect(prompt).not.toContain('Details from b');
    return JSON.stringify({ title: 'Only a', summary: 'a happened.', status: 'active', steps: [] });
  }) as unknown as typeof sdk.queryLLM;
  expect((await consolidate(sdk, DEFAULTS)).rewritten).toBe(1);
  expect(db.query('SELECT source_id FROM source_entities WHERE entity_id=?').all(episode)).toEqual([{ source_id: 'a' }]);

  store.attach(episode, 'b', { role: 'progress', step: 'b', at: DAY, confidence: 1, status: 'accepted', basis: 'test' });
  sdk.queryLLM = (async () => {
    store.detach(episode, 'b', 'test', 'detached during model request');
    return JSON.stringify({ title: 'Stale rewrite', summary: 'Details from b', status: 'active', steps: [] });
  }) as unknown as typeof sdk.queryLLM;
  expect((await consolidate(sdk, DEFAULTS)).rewritten).toBe(0);
  expect(store.get(episode)!.summary).toBe('a happened.');
});
