import { afterEach, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { ensureStorySchema } from '../lib/graph/story-schema';
import { cpmQuality, leiden, type Edge } from '../lib/graph/leiden';
import { hungarian } from '../lib/graph/hungarian';
import { clusterEpisodes, clusterSources, loadAffinityInput, segment } from '../lib/graph/cluster';
import { episodeTitle, memberRole, narrate, runStages, type NarrativeMember } from '../lib/graph/episode-narrative';
import { Assigner, DEFAULTS, assign, recordSignals } from '../extensions/episodes/assign';
import { reconcile } from '../extensions/episodes/clustering';
import { EpisodeStore } from '../sdk/graph/episodes';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const DAY = 86_400_000;

const clique = (nodes: number[], w = 5): Edge[] => nodes.flatMap((a, i) => nodes.slice(i + 1).map(b => ({ a, b, w })));
const groups = (labels: number[]) => {
  const out = new Map<number, number[]>();
  labels.forEach((label, node) => out.set(label, [...out.get(label) ?? [], node]));
  return [...out.values()].map(list => list.join(',')).sort();
};

it('finds dense groups with CPM and is deterministic', () => {
  const edges = [...clique([0, 1, 2, 3]), ...clique([4, 5, 6, 7]), { a: 3, b: 4, w: 1 }];
  const labels = leiden(8, edges, { resolution: 2 });
  expect(groups(labels)).toEqual(['0,1,2,3', '4,5,6,7']);
  expect(leiden(8, edges, { resolution: 2 })).toEqual(labels);
  // A resolution above every edge weight leaves everything apart. The bridge (weight 1) joins the two groups
  // only when it outweighs γ·4·4: not at γ=0.1 (1.6), but at γ=0.05 (0.8).
  expect(groups(leiden(8, edges, { resolution: 6 }))).toHaveLength(8);
  expect(groups(leiden(8, edges, { resolution: 0.1 }))).toHaveLength(2);
  expect(groups(leiden(8, edges, { resolution: 0.05 }))).toEqual(['0,1,2,3,4,5,6,7']);
  expect(cpmQuality(8, edges, labels, 2)).toBeGreaterThan(cpmQuality(8, edges, [0, 0, 0, 0, 0, 0, 0, 0], 2));
});

it('contracts must-links and never joins cannot-links', () => {
  const edges = [...clique([0, 1, 2]), ...clique([3, 4, 5]), { a: 6, b: 0, w: 0.1 }];
  // Node 6 is barely connected; a must-link puts it with 3 regardless.
  const must = leiden(7, edges, { resolution: 2, must: [[6, 3]] });
  expect(must[6]).toBe(must[3]);
  // A cannot-link inside a clique splits it, and a must-link that would violate a cannot-link is dropped.
  const cannot = leiden(7, edges, { resolution: 2, cannot: [[0, 1]], must: [[0, 6], [6, 1]] });
  expect(cannot[0]).not.toBe(cannot[1]);
});

it('matches clusters to episodes by maximum overlap (Hungarian)', () => {
  // Greedy would give row 0 → column 0 (5) and leave row 1 with 1; the optimum is 4 + 4.
  expect(hungarian([[5, 4], [4, 1]])).toEqual([[0, 1], [1, 0]]);
  // Rectangular, and zero-overlap pairs stay unassigned.
  expect(hungarian([[0, 3, 0], [0, 0, 0]])).toEqual([[0, 1]]);
  expect(hungarian([[1], [2], [3]])).toEqual([[2, 0]]);
});

it('segments clusters at long gaps but keeps must-link units whole', () => {
  const at = [0, 1, 2, 100, 101, 50, null].map(day => day === null ? null : day * DAY);
  const unit = (i: number) => (i === 5 ? 2 : i); // node 5 is threaded with node 2
  expect(segment([0, 1, 2, 3, 4, 5, 6], i => at[i]!, unit, 45 * DAY)).toEqual([[0, 1, 2, 5, 6], [3, 4]]);
});

const member = (sourceId: string, day: number, title: string, involvement = 'participant', kind = 'application'): NarrativeMember =>
  ({ sourceId, title, summary: `${title}.`, at: day * DAY, involvement, activity: { kind } });

it('runs per-kind stage machines; only closing outcomes close the episode', () => {
  const rejected = runStages('application', [member('a', 1, 'Thanks for applying to Lumiere'), member('b', 5, 'Interview invitation'),
    member('c', 9, 'We regret to inform you')]);
  expect([rejected.stage, rejected.closed]).toEqual(['rejected', true]);
  expect(rejected.own.get('b')?.name).toBe('interview');
  const offered = runStages('application', [member('a', 1, 'Application received'), member('b', 5, 'Congratulations, you have been admitted'),
    member('c', 9, 'Interview reminder')]);
  // Stages never rewind, and an offer is an outcome that does not end the story (deposit, onboarding follow).
  expect([offered.stage, offered.closed]).toEqual(['offer', false]);
  expect(runStages('purchase', [member('a', 1, 'Your order #123', 'participant', 'purchase'), member('b', 3, 'Your package was delivered', 'participant', 'purchase')]).closed).toBe(true);
  expect(memberRole('application', member('c', 9, 'Unfortunately we regret to inform you'), false)).toBe('outcome');
  expect(memberRole('application', member('d', 9, 'Newsletter', 'observer'), false)).toBe('context');
});

it('titles episodes after their most specific shared entity and avoids taken titles', () => {
  const members = [member('a', 1, 'x'), member('b', 2, 'y')];
  const entities = [{ id: 1, name: 'Google', type: 'Organization', idf: 0.5, support: 2 }, { id: 2, name: 'Lumiere', type: 'Organization', idf: 4, support: 2 },
    { id: 3, name: 'Jane Doe', type: 'Person', idf: 6, support: 2 }, { id: 4, name: 'Rare', type: 'Organization', idf: 9, support: 0 }];
  expect(episodeTitle('application', entities, members, new Set(), 0)).toBe('Lumiere application');
  expect(episodeTitle('application', entities, members, new Set(['lumiereapplication']), Date.UTC(2026, 8, 3))).toBe('Lumiere application (Sep 2026)');
  const narrative = narrate({ members, entities, taken: new Set() });
  expect(narrative.roles).toEqual({ a: 'trigger', b: 'progress' });
  expect(narrative.summary.length).toBeGreaterThan(0);
});

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
  for (let index = 0; index < 20; index++) digest(`filler${index}`, index * DAY, [entity(`Filler ${index}`)], 'none');
  return { db, sdk, entity, digest };
}

it('clusters corroborated sources, applies the pursuit rule, and plugs into the eval harness', () => {
  const { sdk, entity, digest } = fixture();
  const nhpc = entity('NHPC'), project = entity('Rocket', 'Project'), news = entity('Newsletter Co'), issue = entity('Issue', 'Project');
  digest('a', 100 * DAY, [nhpc, project], 'participant', { label: 'Rocket build', kind: 'project' });
  digest('b', 102 * DAY, [nhpc, project], 'author');
  digest('c', 103 * DAY, [nhpc, project], 'observer');
  // The user takes part here, but no digest names an activity: notifications, not a pursuit.
  digest('p1', 100 * DAY, [news, issue], 'participant');
  digest('n1', 100 * DAY, [news, issue], 'observer');
  digest('n2', 101 * DAY, [news, issue], 'observer');
  recordSignals(sdk);
  // Two correlated entities count as one piece of evidence (evidence groups), so a lower resolution than production joins them.
  const options = { resolution: 0.5 };
  const assignment = clusterEpisodes(sdk.database, options);
  expect(assignment.get('a')).toBe(assignment.get('b'));
  expect(assignment.get('c')).toBe(assignment.get('a'));
  // Clusters without a pursuit (observer-only, or no activity) are not episodes.
  expect(assignment.has('n1')).toBe(false);
  expect(assignment.has('p1')).toBe(false);
  const clustering = clusterSources(loadAffinityInput(sdk.database), options);
  expect(clustering.clusters.find(cluster => !cluster.pursuit && cluster.members.length > 1)?.members.length).toBe(3);
});

it('active reconcile creates, attaches, honours manual detachment, and records shadow verdicts in shadow mode', async () => {
  const { sdk, entity, digest } = fixture();
  const nhpc = entity('NHPC'), project = entity('Rocket', 'Project');
  digest('a', 100 * DAY, [nhpc, project], 'participant', { label: 'Rocket build', kind: 'project' });
  digest('b', 102 * DAY, [nhpc, project], 'author');
  digest('c', 104 * DAY, [nhpc, project], 'participant');
  recordSignals(sdk);
  const settings = { ...DEFAULTS, clusteringMode: 'active' as const, clusterResolution: 0.5 };
  const assigner = new Assigner(sdk, settings);
  const store = new EpisodeStore(sdk.database, sdk.graph);
  expect(reconcile(sdk, assigner, settings).created).toBe(1);
  const [episode] = store.list();
  expect(store.get(episode!.id)!.members.map(m => m.sourceId)).toEqual(['a', 'b', 'c']);
  expect(episode!.title).toMatch(/NHPC|Rocket/);
  // A manual detachment is a cannot-link: the next reconcile leaves it out.
  store.detach(episode!.id, 'c', 'user', 'not part of this');
  expect(reconcile(sdk, new Assigner(sdk, settings), settings).attached).toBe(0);
  expect(store.isMember(episode!.id, 'c')).toBe(false);

  // Shadow mode: assign records the clustering's verdict for each source and leaves membership to the greedy pass.
  const other = fixture();
  const org = other.entity('Lumiere');
  other.digest('x', 100 * DAY, [org], 'participant', { label: 'Lumiere application', kind: 'application' });
  other.digest('y', 101 * DAY, [org], 'participant');
  other.sdk.queryLLM = (async () => JSON.stringify({ decisions: [{ source: 1, episode: 1, confidence: 0.9 }] })) as unknown as typeof other.sdk.queryLLM;
  await assign(other.sdk, { ...DEFAULTS, attachScore: 20 });
  const rows = other.db.query<{ subject_key: string; verdict_json: string; llm_verdict_json: string | null }, []>(
    "SELECT subject_key,verdict_json,llm_verdict_json FROM graph_shadow_decisions WHERE kind='episode'").all();
  expect(rows.map(row => row.subject_key)).toContain('source:y');
  // The model reviewed y; its verdict sits beside the clustering's.
  expect(JSON.parse(rows.find(row => row.subject_key === 'source:y')!.llm_verdict_json ?? 'null')?.confidence).toBe(0.9);
});
