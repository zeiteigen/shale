import { afterEach, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createExtensionSDK, type ShaleSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { SourceGraph } from '../sdk/graph/source';
import { run as digest } from '../extensions/knowledge-extractor';
import { repairUserActivities } from '../extensions/knowledge-extractor/repair-digests';
import { run as resolve } from '../extensions/knowledge-graph/resolve';
import { run as assignEpisodes } from '../extensions/episodes';
import { run as consolidateEpisodes } from '../extensions/episodes/consolidate-run';
import { EpisodeStore } from '../sdk/graph/episodes';
import { canonicalOf } from '../sdk/graph/registry';
import { SELF_STABLE_ID } from '../sdk/graph/identity';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKnowledgeGraphMcpServer } from '../mcp/server';

/**
 * The golden thread: a Discord onboarding thread, the user's fork of the onboarding repository on GitHub,
 * and an interview invitation email, all about one club under three spellings. They must end up as one
 * organization and one episode, with the model stubbed to answer as a capable model would.
 */
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const AUG20 = Date.UTC(2026, 7, 20, 17), AUG21 = Date.UTC(2026, 7, 21, 1), SEP25 = Date.UTC(2026, 8, 25, 15), SEP1 = Date.UTC(2026, 8, 1);

function sdkFor(db: Database, extension: string, namespace: string, settings: Record<string, unknown>) {
  const sdk = createExtensionSDK(extension, { database: db, namespace });
  sdk.settings.get = ((key: string) => settings[key]) as typeof sdk.settings.get;
  sdk.settings.getAll = (() => ({ ...settings })) as typeof sdk.settings.getAll;
  return sdk;
}

function ingest(sdk: ShaleSDK, source: { id: string; uri: string; title: string; type: string; origin: string; at: number; to?: number },
  text: string, connector: (graph: SourceGraph, record: number) => void, recordType: string) {
  sdk.ingest.sourceAndChunks({ namespace: source.origin, source: { id: source.id, uri: source.uri, title: source.title, type: source.type,
    origin: source.origin, hash: `${source.id}:v1`, created_at: source.at, updated_at: source.to ?? source.at },
    chunks: [{ text_content: text }] });
  sdk.database.transaction(() => {
    const graph = new SourceGraph(sdk.database, sdk.graph, source.id, source.origin, source.to ?? source.at);
    const record = graph.entity(source.uri, source.title, recordType);
    graph.claim(record, 'SOURCE_URI', { value: source.uri });
    connector(graph, record);
  })();
}

function chat(sdk: ShaleSDK, id: string, at: number, server: [string, string], channel: string, people: Array<[string, string]>, text: string,
  origin = 'discord') {
  ingest(sdk, { id, uri: `${origin}://${id}`, title: `${channel} · ${new Date(at).toISOString().slice(0, 10)}`, type: 'chat_session', origin, at,
    to: at + 600_000 }, text, (graph, session) => {
    const venue = graph.entity(`${origin}://channel/${channel}`, channel, 'Conversation');
    graph.link(session, 'IN_CONVERSATION', venue);
    if (server[0]) graph.link(venue, 'PART_OF', graph.entity(`discord://guild/${server[0]}`, server[1], 'Server'));
    const persons = people.map(([key, name]) => graph.entity(key, name, 'Person'));
    for (const person of persons) graph.link(person, 'PARTICIPATED_IN', venue);
    // As the chat connector does: participants and venue are roles of the window's conversation event.
    graph.event(`chat:${id}`, { name: channel, kind: 'conversation', occurredFrom: at, occurredTo: at + 600_000, participants: [
      { entity: session, role: 'record' }, { entity: venue, role: 'venue' },
      ...persons.map((entity, position) => ({ entity, role: 'participant', position }))] });
    for (const url of text.match(/https?:\/\/\S+/g) ?? []) graph.link(session, 'SHARES_LINK', graph.entity(url, url, 'WebPage'));
  }, 'ChatSession');
}

/** Pull the registry and episode lists back out of a digest prompt, as a model reads them. */
function listed(prompt: string, heading: string) {
  const section = prompt.split(heading)[1]?.split('\n').slice(1) ?? [];
  const rows: Array<{ id: number; label: string }> = [];
  for (const line of section) {
    const match = /^ {2}(\d+): (.*)$/.exec(line);
    if (!match) break;
    rows.push({ id: Number(match[1]), label: match[2]! });
  }
  return rows;
}

function digestResponse(prompt: string) {
  const title = /Source title: "([^"]+)"/.exec(prompt)![1]!;
  const known = listed(prompt, 'Known entities (id: name [type])');
  const episodes = listed(prompt, 'Ongoing episodes (id: title - latest step):');
  const hpc = known.find(row => /HPC|High Performance/i.test(row.label) && /\[Organization\]/.test(row.label))?.id ?? null;
  const episode = episodes.find(row => /HPC/i.test(row.label))?.id;
  const base = { claims: [], events: [] };
  if (title.startsWith('#onboarding-challenge › Someone Else')) return { ...base, entities: [],
    summary: 'Another member asks about memory access in the benchmark.', involvement: 'participant',
    activity: { label: 'Onboarding challenge', kind: 'application', episode: 'new', confidence: 0.6 } };
  if (title.startsWith('#onboarding-challenge')) return { ...base,
    entities: [{ key: 'org', name: 'NHPC', type: 'club', description: 'Northbridge student club for high performance computing',
      urls: ['https://github.com/NHPC/onboarding-template'], match: hpc },
    { key: 'repo', name: 'NHPC/onboarding-template', type: 'GitHub repository', urls: ['https://github.com/NHPC/onboarding-template'] }],
    summary: 'The user forked the NHPC onboarding template and started the heat diffusion problem.', involvement: 'participant',
    activity: { label: 'NHPC onboarding challenge', kind: 'application', stage: 'started the onboarding problem', episode: episode ?? 'new', confidence: 0.8 } };
  if (title.startsWith('example-user/onboarding-template')) return { ...base,
    entities: [{ key: 'org', name: 'NHPC', type: 'Organization', urls: ['https://github.com/NHPC/onboarding-template'], match: hpc },
      { key: 'fork', name: 'example-user/onboarding-template', type: 'Artifact', description: "The user's fork of the NHPC onboarding repository",
        urls: ['https://github.com/example-user/onboarding-template'] }],
    summary: "The user's fork of the NHPC onboarding template for the 2D heat diffusion problem.", involvement: 'author',
    activity: { label: 'NHPC onboarding', kind: 'application', stage: 'working on the onboarding fork', episode: episode ?? 'new', confidence: 0.7 } };
  if (title.startsWith('Interview invitation')) return {
    entities: [{ key: 'club', name: 'Northbridge High Performance Computing club', type: 'Organization',
      searchKeys: ['NHPC', 'NH PC'], urls: ['hpc@northbridge.example.test'], match: hpc, description: 'Student HPC club at the Northbridge' }],
    claims: [{ subject: 'club', predicate: 'INVITES_TO_INTERVIEW', value: 'the user', evidence: [{ chunkIndex: 0, quote: "We'd like to invite you to an interview" }] }],
    events: [], summary: 'The NH PC club invited the user to interview after the onboarding challenge.', involvement: 'participant',
    activity: { label: 'NHPC interview', kind: 'application', stage: 'invited to interview', episode: episode ?? null, confidence: 0.8 } };
  return { ...base, entities: [{ key: 'rocketry', name: 'Northbridge Rocketry', type: 'Organization' }],
    summary: 'People discuss rocket engines.', involvement: 'none', activity: null };
}

function model(prompt: unknown) {
  const text = typeof prompt === 'string' ? prompt : (prompt as { messages: Array<{ content: string }> }).messages[0]!.content;
  if (text.startsWith('Extract a grounded knowledge graph')) return JSON.stringify(digestResponse(text));
  if (text.startsWith('Decide whether each pair')) {
    const pairs = text.split(/\nPair \d+:\n/).slice(1);
    return JSON.stringify({ decisions: pairs.map((pair, index) => ({ pair: index + 1,
      verdict: (pair.match(/HPC|High Performance/gi)?.length ?? 0) >= 2 ? 'same' : 'different', confidence: 0.9, reason: 'stub' })) });
  }
  if (text.startsWith('Decide whether a new source continues')) return JSON.stringify({ episode: /1\. [^\n]*HPC/.test(text) ? 1 : 0, confidence: 0.9 });
  if (text.startsWith('Rewrite the record')) return JSON.stringify({ title: 'Joining NHPC: onboarding to interview',
    summary: 'The user worked through the NHPC onboarding challenge and was invited to interview.', status: 'active',
    steps: [{ source: 1, step: 'Started the onboarding challenge' }, { source: 3, step: 'Invited to interview' }] });
  if (text.startsWith('Are these two records the same pursuit')) return JSON.stringify({ same: false, confidence: 0.9 });
  throw new Error(`Unexpected prompt: ${text.slice(0, 80)}`);
}

it('joins a Discord thread, a GitHub fork, and an interview email into one organization and one episode', async () => {
  const db = createTestDatabase(); databases.push(db);
  const extractor = sdkFor(db, 'knowledge-extractor', 'knowledge', { enabled: true, maxSourcesPerRun: 1, maxContentChars: 12000,
    namespace: 'knowledge', llmModel: 'test-model' });
  const graphSdk = sdkFor(db, 'knowledge-graph', 'knowledge', { resolverEnabled: true, selfNames: ['Alex Morgan'],
    selfEmails: ['alex@example.test'], selfHandles: ['discord-user:900', 'github:example-user'], maxAdjudicationsPerRun: 32 });
  const episodes = sdkFor(db, 'episodes', 'episodes', { enabled: true, maxSourcesPerRun: 200, attachScore: 4, reviewScore: 0.5,
    recencyDays: 45, maxAdjudicationsPerRun: 12, dormantDays: 4500 });
  for (const sdk of [extractor, graphSdk, episodes]) sdk.queryLLM = (async (prompt: unknown) => model(prompt)) as unknown as typeof sdk.queryLLM;

  chat(extractor, 'discord-window:onboarding', AUG20, ['147', 'NHPC'], '#onboarding-challenge › Alex Morgan',
    [['discord:user:900', 'example-user'], ['discord:user:901', 'mentor']],
    '— 2026-08-20 —\n[17:00] example-user: Hi! I forked the NHPC onboarding template https://github.com/NHPC/onboarding-template and started on the heat diffusion problem.\n[17:05] mentor: Great, post your benchmark score when ready.');
  ingest(extractor, { id: 'web:fork', uri: 'https://github.com/example-user/onboarding-template', title: 'example-user/onboarding-template',
    type: 'web_page', origin: 'browser', at: AUG21 }, "NHPC Onboarding — 2D Heat Diffusion\nStarter repository for the NHPC onboarding problem.\nMerge branch 'main' of https://github.com/NHPC/onboarding-template",
  (graph, page) => graph.link(page, 'BELONGS_TO_DOMAIN', graph.entity('github.com', 'github.com', 'Domain')), 'WebPage');
  chat(extractor, 'email-window:interview', SEP25, ['', ''], 'Interview invitation - NH PC Club', [['email:user:hpc@northbridge.example.test', 'NH PC Recruiting']],
    "Subject: Interview invitation - NH PC Club\nFrom: NH PC Recruiting <hpc@northbridge.example.test>\nTo: alex@example.test\n\nHi Alex, thanks for completing the onboarding challenge for the Northbridge High Performance Computing club. We'd like to invite you to an interview next week.", 'email');
  chat(extractor, 'discord-window:rocketry', SEP1, ['555', 'Northbridge Rocketry'], '#engines', [['discord:user:777', 'rocketeer']],
    '— 2026-09-01 —\n[10:00] rocketeer: The Northbridge Rocketry engine test is on Saturday.');

  chat(extractor, 'discord-window:bystander', AUG20 - 86_400_000, ['147', 'NHPC'], '#onboarding-challenge › Someone Else',
    [['discord:user:555', 'someone']], '— 2026-08-19 —\n[10:00] someone: Is there a better memory access pattern for sparse grids?');

  await resolve(graphSdk);
  for (let index = 0; index < 5; index++) expect((await digest(extractor)).committed).toBe(1);
  await resolve(graphSdk);
  await assignEpisodes(episodes);
  await consolidateEpisodes(episodes);

  const orgs = db.query<{ id: number }, []>(`SELECT e.id FROM entities e WHERE e.namespace='knowledge' AND e.type='Organization'
    AND (e.display_name LIKE '%HPC%' OR e.display_name LIKE '%High Performance%')`).all().map(row => canonicalOf(db, row.id));
  expect(orgs.length).toBe(3);
  expect(new Set(orgs).size).toBe(1);
  const org = orgs[0]!;
  const origins = db.query<{ origin: string }, [number]>(`SELECT DISTINCT s.origin FROM source_entities se JOIN sources s ON s.id=se.source_id
    WHERE se.entity_id=?`).all(org).map(row => row.origin).sort();
  expect(origins).toEqual(['browser', 'discord', 'email']);

  const server = db.query<{ id: number }, []>("SELECT id FROM entities WHERE type='Server' AND display_name='NHPC'").get()!.id;
  expect(db.query("SELECT status FROM graph_claims WHERE predicate='COMMUNITY_OF' AND subject_id=? AND object_id=?").get(server, org))
    .toEqual({ status: 'accepted' });
  const self = db.query<{ id: number }, [string]>('SELECT id FROM entities WHERE stable_id=?').get(SELF_STABLE_ID)!.id;
  const discordUser = db.query<{ entity_id: number }, []>("SELECT entity_id FROM graph_aliases WHERE scope='connector-key' AND alias='discord:user:900'").get()!;
  expect(canonicalOf(db, discordUser.entity_id)).toBe(self);
  const rocketry = db.query<{ id: number }, []>("SELECT id FROM entities WHERE display_name='Northbridge Rocketry' AND namespace='knowledge'").get()!.id;
  expect(canonicalOf(db, rocketry)).not.toBe(org);

  const store = new EpisodeStore(db, episodes.graph);
  const all = store.list();
  expect(all).toHaveLength(1);
  const episode = store.get(all[0]!.id)!;
  expect(episode.title).toBe('Joining NHPC: onboarding to interview');
  expect(episode.members.map(member => [member.sourceId, member.role])).toEqual([
    ['discord-window:onboarding', 'trigger'], ['web:fork', 'progress'], ['email-window:interview', 'outcome']]);
  expect(episode.members[2]!.step).toBe('Invited to interview');
  expect(episode.involves.map(entity => entity.id)).toContain(org);
  expect(store.list({ query: 'NHPC interview' }).map(item => item.id)).toEqual([episode.id]);
  expect(store.list({ entityId: org }).map(item => item.id)).toEqual([episode.id]);
  expect(db.query("SELECT episode_state FROM graph_source_digests WHERE source_id='discord-window:rocketry'").get()).toEqual({ episode_state: 'none' });
  // The model said the user took part in someone else's thread; the connector's participant list overrules it.
  expect(db.query("SELECT involvement FROM graph_source_digests WHERE source_id='discord-window:bystander'").get()).toEqual({ involvement: 'observer' });
  expect(db.query("SELECT activity FROM graph_source_digests WHERE source_id='discord-window:bystander'").get()).toEqual({ activity: null });
  // Repair cached outputs from older extractor versions using the same connector constraint.
  db.query("UPDATE graph_source_digests SET activity=? WHERE source_id='discord-window:bystander'")
    .run(JSON.stringify({ label: 'Unsupported pursuit', kind: 'application' }));
  expect(repairUserActivities(extractor)).toEqual({ repaired: 1 });
  expect(repairUserActivities(extractor)).toEqual({ repaired: 0 });
  expect(db.query("SELECT activity FROM graph_source_digests WHERE source_id='discord-window:bystander'").get()).toEqual({ activity: null });
  expect(extractor.state.getJson('digest-activity-repair:discord-window:bystander')).toMatchObject({
    previousActivity: { label: 'Unsupported pursuit' }, reason: 'The connector does not list the user as a participant' });
  expect(episode.members.map(member => member.sourceId)).not.toContain('discord-window:bystander');

  // Graph search reaches the episode from a passage that never names it.
  const result = await extractor.search.graph({ query: 'heat diffusion benchmark', mode: 'bm25', limit: 5, maxSeeds: 3 });
  expect(result.neighborhoods.flatMap(n => n.entities.map(entity => entity.id))).toContain(episode.id);

  // The same story through MCP: search names the episode, which reads back as a timeline and can be corrected.
  const mcp = createKnowledgeGraphMcpServer({ sdk: extractor });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: 'thread-test', version: '1.0.0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }> };
    return JSON.parse(response.content[0]!.text);
  };
  const searched = await call('search_graph', { query: 'interview' });
  expect(searched.episodes.map((item: { id: number }) => item.id)).toEqual([episode.id]);
  const read = await call('get_episode', { id: episode.id });
  expect(read.members.map((member: { at: string }) => member.at)).toEqual(['2026-08-20', '2026-08-21', '2026-09-25']);
  const timeline = await call('entity_timeline', { entity: org });
  expect(timeline.sources.map((source: { id: string }) => source.id))
    .toEqual(['discord-window:onboarding', 'web:fork', 'email-window:interview']);
  const split = await call('split_episode', { episode: episode.id, sourceIds: ['email-window:interview'], title: 'NHPC interview', reason: 'test' });
  expect(store.get(split.episodeId)!.members.map(member => member.sourceId)).toEqual(['email-window:interview']);
  expect(store.get(episode.id)!.members).toHaveLength(2);
  await call('merge_episodes', { from: split.episodeId, into: episode.id, reason: 'test' });
  expect(store.get(episode.id)!.members).toHaveLength(3);
  await client.close();
});
