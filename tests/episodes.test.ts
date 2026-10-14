import { afterEach, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { ensureStorySchema } from '../lib/graph/story-schema';
import { Assigner, DEFAULTS, assign, episodeByLabel, idf, pendingDigests, recordSignals } from '../extensions/episodes/assign';
import { indexEntity, shortlist } from '../sdk/graph/registry';
import { EpisodeStore } from '../sdk/graph/episodes';
import { consolidate, mergeCandidates, mergeSameTitled } from '../extensions/episodes/consolidate';
import { reconsiderContext } from '../extensions/episodes/reconsider';
import { auditEpisode, refreshInvolvement } from '../extensions/episodes/involvement';

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
  const common = entity('Discord'), rare = entity('NHPC');
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
  const org = entity('NHPC'), other = entity('Northbridge Rocketry');
  for (let index = 0; index < 20; index++) digest(`filler${index}`, index * DAY, [entity(`Filler ${index}`)], 'none');
  digest('start', 100 * DAY, [org], 'participant', { label: 'NHPC onboarding', kind: 'application' });
  digest('progress', 101 * DAY, [org], 'author', { label: 'NHPC onboarding', kind: 'application', stage: 'submitted' });
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
  const organization = entity('NHPC'), platform = entity('GitHub', 'Product');
  for (let index = 0; index < 40; index++)
    digest(`background-${index}`, DAY, index < 17 ? [organization, platform] : [entity(`Other ${index}`)], 'none');
  digest('interview', 2 * DAY, [organization], 'participant', { label: 'NHPC interview', kind: 'application' });
  digest('generic-visit', 2 * DAY, [platform], 'observer');
  recordSignals(sdk);
  const store = new EpisodeStore(sdk.database, sdk.graph);
  const onboarding = store.create({ title: 'NHPC onboarding', kind: 'application', at: DAY });
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
  const episode = store.create({ title: 'NHPC onboarding', kind: 'application', at: DAY });
  const attach = () => store.attach(episode, 'a', { role: 'progress', step: 's', at: DAY, confidence: 1, status: 'accepted', basis: 't' });
  attach();
  store.detach(episode, 'a', 'test', 'wrong episode');
  expect(store.isMember(episode, 'a')).toBe(false);
  attach();
  expect(store.isMember(episode, 'a')).toBe(true);
  expect(store.ofSource('a')).toEqual([episode]);

  for (let index = 0; index < 30; index++) indexEntity(sdk.database, entity(`NHPC member ${index}`, 'Person'));
  indexEntity(sdk.database, episode);
  expect(shortlist(sdk.database, { texts: ['NHPC'], types: ['Episode'], limit: 5 }).map(entry => entry.id)).toEqual([episode]);

  sdk.database.run("UPDATE graph_source_digests SET episode_state='review' WHERE source_id='a'");
  await assign(sdk, DEFAULTS);
  expect(sdk.database.query("SELECT episode_state FROM graph_source_digests WHERE source_id='a'").get()).not.toEqual({ episode_state: 'review' });
});

it('reviews split pursuits across merged organization identities and reconsiders declines after new evidence', () => {
  const { sdk, entity, db } = fixture();
  const org = entity('NHPC'), alias = entity('Northbridge High Performance Computing'), platform = entity('GitHub', 'Product');
  const store = new EpisodeStore(db, sdk.graph);
  const first = store.create({ title: 'NHPC onboarding', kind: 'application', at: DAY });
  const second = store.create({ title: 'NHPC interview', kind: 'application', at: 2 * DAY });
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
  const org = entity('NHPC');
  for (let index = 0; index < 20; index++) digest(`filler-${index}`, DAY, [entity(`Other ${index}`)], 'none');
  digest('announcement', DAY, [org], 'observer', { label: 'Example Research Application Process', kind: 'application' });
  await assign(sdk, DEFAULTS);
  expect(sdk.database.query("SELECT episode_state FROM graph_source_digests WHERE source_id='announcement'").get())
    .toEqual({ episode_state: 'none' });
  digest('application', 2 * DAY, [org], 'participant', { label: 'NHPC onboarding', kind: 'application' });
  await assign(sdk, DEFAULTS);
  let reviewed = 0;
  sdk.queryLLM = (async () => { reviewed++; return JSON.stringify({ decisions: [{ source: 1, episode: 1, confidence: 0.9 }] }); }) as unknown as typeof sdk.queryLLM;
  await assign(sdk, DEFAULTS);
  expect(reviewed).toBe(1);
  const store = new EpisodeStore(sdk.database, sdk.graph);
  expect(store.get(store.list()[0].id)!.members.map(member => [member.sourceId, member.role]))
    .toEqual([['announcement', 'context'], ['application', 'trigger']]);
  expect(sdk.graph.entities.inspect(store.list()[0].id).aliases.map(alias => alias.alias)).not.toContain('Example Research Application Process');
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

it('joins notes to the episode their activity label names, even before their entities are resolved', async () => {
  const { sdk, entity, digest } = fixture();
  for (let index = 0; index < 20; index++) digest(`filler${index}`, index * DAY, [entity(`Filler ${index}`)], 'none');
  const label = { label: 'Global Politics Revision', kind: 'learning' };
  // Every note minted its own course entity; the identity resolver has not merged them yet.
  for (let index = 0; index < 4; index++) digest(`note${index}`, 30 * DAY + index, [entity(`Global Politics ${index}`, 'Course')], 'author', label);
  digest('much-later', 200 * DAY, [entity('Global Politics late', 'Course')], 'author', label);
  let calls = 0;
  sdk.queryLLM = (async () => { calls++; return '{"decisions":[]}'; }) as unknown as typeof sdk.queryLLM;
  await assign(sdk, DEFAULTS);
  expect(calls).toBe(0);
  const store = new EpisodeStore(sdk.database, sdk.graph);
  const episodes = store.list().map(item => store.get(item.id)!);
  expect(episodes.map(episode => episode.members.length).sort()).toEqual([1, 4]);
  // A label match only reaches back recencyDays.
  expect(episodeByLabel(sdk, 'global politics revision', 31 * DAY, 45)).toBe(episodes.find(episode => episode.members.length === 4)!.id);
});

it('starts one episode when parallel reviews both report a new pursuit with the same label', async () => {
  const { sdk, entity, digest } = fixture();
  const club = entity('Chess Club');
  for (let index = 0; index < 20; index++) digest(`filler${index}`, index * DAY, [entity(`Filler ${index}`)], 'none');
  digest('seed', 29 * DAY, [club], 'author', { label: 'Chess Club events', kind: 'other' });
  await assign(sdk, DEFAULTS);
  for (const id of ['a', 'b']) digest(id, 30 * DAY, [club], 'participant', { label: 'Chess tournament prep', kind: 'learning' });
  let calls = 0;
  sdk.queryLLM = (async (prompt: string) => {
    calls++;
    expect(prompt).toContain('Source 2');
    return JSON.stringify({ decisions: [{ source: 1, episode: 0, newEpisode: true, confidence: 0.9 },
      { source: 2, episode: 0, newEpisode: true, confidence: 0.9 }] });
  }) as unknown as typeof sdk.queryLLM;
  expect((await assign(sdk, { ...DEFAULTS, attachScore: 100, reviewScore: 0.1 })).reviewed).toBe(2);
  expect(calls).toBe(1);
  const store = new EpisodeStore(sdk.database, sdk.graph);
  const prep = store.list().filter(item => item.title === 'Chess tournament prep');
  expect(prep).toHaveLength(1);
  expect(store.get(prep[0]!.id)!.members.map(member => member.sourceId).sort()).toEqual(['a', 'b']);
});

it('leaves sources the batched review did not answer for the next run', async () => {
  const { sdk, entity, digest } = fixture();
  const club = entity('Chess Club');
  for (let index = 0; index < 20; index++) digest(`filler${index}`, index * DAY, [entity(`Filler ${index}`)], 'none');
  digest('seed', 29 * DAY, [club], 'author', { label: 'Chess Club events', kind: 'other' });
  await assign(sdk, DEFAULTS);
  for (const id of ['a', 'b', 'c']) digest(id, 30 * DAY, [club], 'observer');
  sdk.queryLLM = (async () => JSON.stringify({ decisions: [{ source: 2, episode: 1, confidence: 0.9 }, { source: 3, episode: 0, confidence: 0.9 }] })) as unknown as typeof sdk.queryLLM;
  await assign(sdk, { ...DEFAULTS, attachScore: 100, reviewScore: 0.1 });
  const state = (id: string) => sdk.database.query<{ episode_state: string }, [string]>(
    'SELECT episode_state FROM graph_source_digests WHERE source_id=?').get(id)!.episode_state;
  expect(['a', 'b', 'c'].map(state)).toEqual(['pending', 'assigned', 'none']);
});

it('folds identically titled open episodes within the recency window without the model', async () => {
  const { sdk, db, digest } = fixture();
  const store = new EpisodeStore(db, sdk.graph);
  let sources = 0;
  const make = (title: string, at: number, kind = 'learning') => {
    const id = store.create({ title, kind, at }), source = `note${++sources}`;
    digest(source, at, []);
    store.attach(id, source, { role: 'trigger', step: 'note', at, confidence: 1, status: 'accepted', basis: 'test' });
    return id;
  };
  const first = make('Global Politics Revision', DAY), second = make('global politics revision', 2 * DAY);
  const third = make('Global Politics Revision', 3 * DAY), distant = make('Global Politics Revision', 300 * DAY);
  const otherKind = make('Global Politics Revision', 2 * DAY, 'project');
  const closed = make('Global Politics Revision', 2 * DAY);
  db.query("UPDATE graph_episodes SET status='closed' WHERE entity_id=?").run(closed);
  // A merge the user undid stays undone.
  const undone = make('Global Politics Revision', 4 * DAY);
  sdk.graph.entities.unmerge(store.merge(undone, first, 'test'));
  expect(mergeSameTitled(sdk, store, 45)).toBe(3);
  const open = store.list().filter(item => item.status !== 'closed').map(item => item.id).sort((a, b) => a - b);
  expect(open).toEqual([first, distant, undone].sort((a, b) => a - b));
  // The model's kind label varies between notes of one story, so it does not keep them apart.
  expect(store.get(first)!.members).toHaveLength(4);
  expect([second, third, otherKind, closed].map(id => store.get(id)?.id)).toEqual([first, first, first, closed]);
  let calls = 0;
  sdk.queryLLM = (async () => { calls++; return '{}'; }) as unknown as typeof sdk.queryLLM;
  // Single-member episodes are rewritten from their digest; the merged one still asks the model.
  const result = await consolidate(sdk, DEFAULTS);
  expect(calls).toBe(1);
  expect(result.rewritten).toBe(3);
  expect(store.get(distant)!.summary).toBe('note4 happened.');
});

it('lets ordinary members use an episode\'s hooks without adding their own entities or labels', async () => {
  const { sdk, entity, digest } = fixture();
  const club = entity('Chess Club'), google = entity('Google');
  for (let index = 0; index < 20; index++) digest(`filler${index}`, index * DAY, [entity(`Filler ${index}`)], 'none');
  digest('seed', 30 * DAY, [club], 'author', { label: 'Chess Club events', kind: 'other' });
  digest('joint', 31 * DAY, [club, google], 'participant', { label: 'Account setup', kind: 'admin' });
  digest('alert', 32 * DAY, [google], 'participant');
  const settings = { ...DEFAULTS, attachScore: 2, reviewScore: 1 };
  await assign(sdk, settings);
  const store = new EpisodeStore(sdk.database, sdk.graph);
  const [episode] = store.list();
  expect(store.get(episode!.id)!.members.map(member => member.sourceId)).toEqual(['seed', 'joint']);
  expect(store.involved(episode!.id).map(item => item.id)).toEqual([club]);
  expect(sdk.database.query("SELECT episode_state FROM graph_source_digests WHERE source_id='alert'").get()).toEqual({ episode_state: 'none' });
  // The joining source's own label is not a name of the episode, so later notes with that label start their own.
  expect(episodeByLabel(sdk, 'Account setup', 33 * DAY, 45)).toBeNull();
});

it('repairs a drifted episode: retracts unsupported hooks and aliases and detaches what they let in', async () => {
  const { sdk, db, entity, digest } = fixture();
  const club = entity('Chess Club'), google = entity('Google'), venue = entity('Town Hall');
  for (let index = 0; index < 20; index++) digest(`filler${index}`, index * DAY, [entity(`Filler ${index}`)], 'none');
  digest('seed', 30 * DAY, [club], 'author', { label: 'Chess Club events', kind: 'other' });
  await assign(sdk, DEFAULTS);
  const store = new EpisodeStore(db, sdk.graph);
  const episode = store.list()[0]!.id;
  // What the old assigner left behind: a hook from a weak member, the alert it let in, and that member's label.
  for (const [id, entities, involvement] of [['alert', [google], 'participant'], ['page', [google], 'observer']] as const) {
    digest(id, 31 * DAY, [...entities], involvement);
    db.query("UPDATE graph_source_digests SET episode_state='assigned',signals_at=1 WHERE source_id=?").run(id);
    db.query('INSERT INTO graph_digest_signals(source_id,entity_id) VALUES(?,?)').run(id, google);
  }
  store.involve(episode, google, 3);
  store.attach(episode, 'alert', { role: 'progress', step: 'alert', at: 31 * DAY, confidence: 1, status: 'accepted', basis: 'score 9.00: google' });
  store.attach(episode, 'page', { role: 'context', step: 'page', at: 31 * DAY, confidence: 0.95, status: 'accepted', basis: 'model review 0.95' });
  sdk.graph.entities.addAlias(episode, 'Winter co-op search', 'search');
  sdk.graph.claims.add({ id: 'manual-venue', namespace: 'episodes', subject: episode, predicate: 'INVOLVES', object: venue,
    status: 'accepted', method: 'manual' });

  expect(auditEpisode(sdk, new Assigner(sdk, DEFAULTS), episode)).toEqual({ changed: true, pruned: 1 });
  expect(store.involved(episode).map(item => item.id).sort()).toEqual([club, venue].sort());
  expect(store.get(episode)!.members.map(member => member.sourceId)).toEqual(['seed', 'page']);
  expect(db.query("SELECT episode_state FROM graph_source_digests WHERE source_id='alert'").get()).toEqual({ episode_state: 'pending' });
  expect(sdk.graph.entities.inspect(episode).aliases.map(alias => alias.alias)).not.toContain('Winter co-op search');
  // A second audit finds nothing left to do, and the detached alert does not come back.
  expect(auditEpisode(sdk, new Assigner(sdk, DEFAULTS), episode)).toEqual({ changed: false, pruned: 0 });
  await assign(sdk, DEFAULTS);
  expect(store.isMember(episode, 'alert')).toBe(false);
});

it('keeps hooks carried by enough defining sources, and anything the title names', async () => {
  const { sdk, entity, digest } = fixture();
  const shared = entity('Onboarding repo', 'Project'), atlas = entity('Atlas', 'Project');
  const listed = [entity('Old game', 'Project'), entity('Toy language', 'Project')];
  for (let index = 0; index < 20; index++) digest(`filler${index}`, index * DAY, [entity(`Filler ${index}`)], 'none');
  const label = { label: 'Atlas onboarding', kind: 'application' };
  // The trigger is a repository list page: it names every repository, not just the one this pursuit is about.
  digest('repositories', 30 * DAY, [shared, atlas, ...listed], 'author', label);
  for (let index = 0; index < 7; index++) digest(`step${index}`, 31 * DAY + index, [shared], 'author', label);
  await assign(sdk, DEFAULTS);
  const store = new EpisodeStore(sdk.database, sdk.graph);
  const [episode] = store.list();
  expect(store.get(episode!.id)!.members).toHaveLength(8);
  expect(store.involved(episode!.id).map(item => item.id).sort()).toEqual([shared, atlas].sort());
  // Derivation is idempotent.
  expect(refreshInvolvement(sdk, store, episode!.id)).toBe(false);
});

