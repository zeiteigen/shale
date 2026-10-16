import type { ShaleSDK } from '@shale/sdk';
import { canonicalOf } from '../../sdk/graph/registry';
import { CLUSTER_DEFAULTS, clusterSources, loadAffinityInput, type Clustering } from '../../lib/graph/cluster';
import { narrate, type Narrative, type NarrativeEntity, type NarrativeMember } from '../../lib/graph/episode-narrative';
import { recordShadow } from '../../lib/graph/shadow';
import { fullNameKey } from '../../lib/graph/identity-keys';
import { digestFor, digestTotal, idf, participating, type Assigner, type DEFAULTS, type Pending } from './assign';
import { definingMembers } from './involvement';

/**
 * Glue between the episodes cron and lib/graph/cluster.ts (global, constrained clustering of every digested
 * source) and lib/graph/episode-narrative.ts (deterministic titles, summaries, stages).
 *
 * shadow: compute the clustering after the greedy pass and record, per source, which existing episode its
 *         cluster maps to (graph_shadow_decisions kind 'episode', subject 'source:<id>', method 'cluster');
 *         the model's review and merge verdicts are attached to the same rows.
 * active: the clustering replaces the model's middle-band review and duplicate merging. Only diffs are
 *         written through EpisodeStore, protected members (manual, model-confirmed, closed episodes) are
 *         must-links that never move, an ordinary member moves only when its affinity gain exceeds the
 *         hysteresis margin, and each run makes at most maxClusterChangesPerRun changes.
 * Writes from clustering carry basis "cluster …" and actor "episodes-cluster".
 */
export const CLUSTER_METHOD = 'cluster';
const ACTOR = 'episodes-cluster';
const MERGE_SHARE = 0.6;

export function clusterOptions(settings: typeof DEFAULTS) {
  return { resolution: settings.clusterResolution, tauDays: settings.clusterTauDays, dormantDays: settings.dormantDays, protectExisting: true };
}

export function computeClustering(sdk: ShaleSDK, settings: typeof DEFAULTS): Clustering {
  const options = clusterOptions(settings);
  return clusterSources(loadAffinityInput(sdk.database, options), options);
}

/** Per source: the existing episode its cluster continues (or null), the cluster key, and whether it is a pursuit. */
export function sourceVerdicts(clustering: Clustering) {
  const out = new Map<string, { episode: number | null; cluster: string | null; pursuit: boolean; context: boolean }>();
  clustering.input.nodes.forEach((node, i) => {
    const c = clustering.clusterOf[i]!;
    const cluster = c >= 0 ? clustering.clusters[c]! : null;
    out.set(node.id, { episode: cluster?.pursuit ? cluster.episode : null, cluster: cluster?.pursuit ? cluster.key : null,
      pursuit: Boolean(cluster?.pursuit), context: Boolean(cluster?.context.includes(i)) });
  });
  return out;
}

/** Shadow mode: record the clustering's verdict for every digested source (one transaction, upserts). */
export function recordClusterShadow(sdk: ShaleSDK, clustering: Clustering, only?: Set<string>) {
  const verdicts = sourceVerdicts(clustering);
  sdk.database.transaction(() => {
    for (const [source, verdict] of verdicts) if (!only || only.has(source))
      recordShadow(sdk.database, { kind: 'episode', subject: `source:${source}`, method: CLUSTER_METHOD, verdict });
  })();
  return verdicts.size;
}

/** Whether the clustering puts most of episode a's members in the same cluster as most of b's. */
export function sameCluster(clustering: Clustering, a: number, b: number): boolean {
  const majority = (episode: number) => {
    const counts = new Map<number, number>();
    let total = 0;
    clustering.input.nodes.forEach((node, i) => {
      if (!(clustering.input.membership.get(node.id) ?? []).some(m => m.episode === episode)) return;
      total++;
      const c = clustering.clusterOf[i]!;
      if (c >= 0) counts.set(c, (counts.get(c) ?? 0) + 1);
    });
    const best = [...counts].sort((x, y) => y[1] - x[1])[0];
    return best && best[1] >= MERGE_SHARE * total ? best[0] : -1;
  };
  const ca = majority(a);
  return ca >= 0 && ca === majority(b);
}

const parse = (raw: string | null) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

/**
 * Active mode: apply the clustering's diffs. `reviews` are the middle-band sources the model would have
 * judged; whatever the clustering does not place is started as a new episode (user activity) or marked none.
 */
export function reconcile(sdk: ShaleSDK, assigner: Assigner, settings: typeof DEFAULTS, reviews: Pending[] = [], clustering = computeClustering(sdk, settings)) {
  const db = sdk.database, store = assigner.store, input = clustering.input;
  const budget = { left: settings.maxClusterChangesPerRun };
  const result = { merged: 0, attached: 0, moved: 0, created: 0, started: 0, none: 0 };
  const basis = (score: number) => `cluster γ=${clustering.options.resolution} affinity ${score.toFixed(2)}`;
  const membersOf = (episode: number) => input.nodes.flatMap((node, i) =>
    (input.membership.get(node.id) ?? []).some(m => canonicalOf(db, m.episode) === canonicalOf(db, episode)) ? [i] : []);
  const separated = (a: number, b: number) => input.separated.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

  // 1. Merges: an open episode the matching left unmatched whose members mostly sit in a cluster continued by another.
  const matched = new Set(clustering.clusters.flatMap(cluster => cluster.episode === null ? [] : [cluster.episode]));
  for (const [episode, meta] of input.episodes) {
    if (budget.left <= 0) break;
    if (matched.has(episode) || meta.status === 'closed') continue;
    const members = membersOf(episode);
    if (!members.length) continue;
    const counts = new Map<number, number>();
    for (const i of members) { const c = clustering.clusterOf[i]!; if (c >= 0) counts.set(c, (counts.get(c) ?? 0) + 1); }
    const [c, n] = [...counts].sort((x, y) => y[1] - x[1])[0] ?? [-1, 0];
    const into = c >= 0 ? clustering.clusters[c]!.episode : null;
    if (into === null || n < MERGE_SHARE * members.length || separated(episode, into)) continue;
    // Direct evidence between the two stories, not just a chain through the cluster: the strongest link of each
    // member of the smaller side to the other side, averaged, must reach the merge affinity.
    const others = membersOf(into);
    const [small, large] = members.length <= others.length ? [members, others] : [others, members];
    const between = small.reduce((sum, i) => sum + Math.max(0, ...large.map(j => clustering.affinity(i, j))), 0) / Math.max(1, small.length);
    if (between < settings.clusterMergeAffinity) continue;
    const [from, survivor] = (input.episodes.get(into)?.startedAt ?? Infinity) <= (meta.startedAt ?? Infinity) ? [episode, into] : [into, episode];
    if (canonicalOf(db, from) === canonicalOf(db, survivor)) continue;
    store.merge(from, survivor, `Same pursuit (cluster γ=${clustering.options.resolution}, ${n}/${members.length} members, affinity ${between.toFixed(2)})`);
    clustering.clusters[c]!.episode = survivor;
    result.merged++; budget.left--;
  }

  // 2. Attach and move members of clusters that continue an episode; create episodes for new pursuit clusters.
  const reviewed = new Map(reviews.map(pending => [pending.digest.source_id, pending]));
  const placed = new Set<string>();
  const pendingFor = (source: string): Pending | null => {
    const known = reviewed.get(source);
    if (known) return known;
    const digest = digestFor(sdk, source);
    return digest ? { digest, activity: parse(digest.activity), signals: new Map(), candidates: [] } : null;
  };
  for (const cluster of clustering.clusters) {
    if (!cluster.pursuit) continue;
    const all = [...cluster.members, ...cluster.context];
    if (cluster.episode === null) {
      // A new pursuit: only sources no episode holds, at least two of them, at least one the user's own.
      const free = all.filter(i => input.nodes[i]!.present && !(input.membership.get(input.nodes[i]!.id) ?? []).length);
      if (free.length < 2 || !free.some(i => participating({ involvement: input.nodes[i]!.involvement })) || budget.left < free.length + 1) continue;
      const first = free.reduce((a, b) => (input.nodes[a]!.at ?? Infinity) <= (input.nodes[b]!.at ?? Infinity) ? a : b);
      const narrative = narrate({ members: free.map(i => narrativeMember(input.nodes[i]!)), entities: clusterEntities(clustering, free), taken: openTitles(sdk) });
      const pending = pendingFor(input.nodes[first]!.id);
      if (!pending) continue;
      const episode = store.create({ title: narrative.title, kind: narrative.kind, at: input.nodes[first]!.at });
      assigner.attach(episode, pending, 'accepted', 0.7, basis(clustering.affinityTo(first, free)), true);
      placed.add(input.nodes[first]!.id);
      for (const i of free) {
        if (i === first) continue;
        const member = pendingFor(input.nodes[i]!.id);
        if (!member) continue;
        assigner.attach(episode, member, 'accepted', 0.7, basis(clustering.affinityTo(i, free)));
        placed.add(input.nodes[i]!.id);
      }
      result.created++; budget.left -= free.length + 1;
      continue;
    }
    const target = canonicalOf(db, cluster.episode);
    const current = membersOf(target);
    for (const i of all) {
      if (budget.left <= 0) break;
      const node = input.nodes[i]!;
      if (!node.present || input.detached.get(node.id)?.has(target)) continue;
      const memberships = (input.membership.get(node.id) ?? []).map(m => ({ ...m, episode: canonicalOf(db, m.episode) }));
      if (memberships.some(m => m.episode === target)) continue;
      if (memberships.some(m => m.protected)) continue;
      const gain = clustering.affinityTo(i, current);
      const pending = pendingFor(node.id);
      if (!pending) continue;
      if (memberships.length) {
        // Hysteresis: move only when the new episode is clearly closer than the one it is in.
        // Never empty an episode: a sole member is its story, and folding it is the merge rule's call.
        if (memberships.some(m => membersOf(m.episode).filter(j => j !== i && input.nodes[j]!.present).length === 0)) continue;
        const here = Math.max(...memberships.map(m => clustering.affinityTo(i, membersOf(m.episode))));
        if (gain - here < settings.clusterHysteresis) continue;
        if (budget.left < 2) break;
        for (const m of memberships) store.detach(m.episode, node.id, ACTOR, `closer to episode ${target} (cluster affinity ${gain.toFixed(2)} vs ${here.toFixed(2)})`);
        assigner.attach(target, pending, 'accepted', Math.min(1, 0.5 + gain / 20), basis(gain));
        result.moved++; budget.left -= 2;
      } else {
        // An unplaced source joins only with real affinity to the episode's members, not just to cluster newcomers.
        // One incidental shared mention (both name WhatsApp) is not enough to join an existing story.
        if (gain < settings.clusterHysteresis / 2 || !clustering.corroborated(i, current)) continue;
        assigner.attach(target, pending, gain >= settings.clusterHysteresis ? 'accepted' : 'proposed', Math.min(1, 0.4 + gain / 20), basis(gain));
        result.attached++; budget.left--;
      }
      placed.add(node.id);
    }
  }

  // 3. Review items the clustering did not place: a new pursuit of the user's starts an episode, the rest is none.
  for (const pending of reviews) {
    const source = pending.digest.source_id;
    const state = db.query<{ episode_state: string }, [string]>('SELECT episode_state FROM graph_source_digests WHERE source_id=?').get(source)?.episode_state;
    if (placed.has(source) || state !== 'review') continue;
    if (pending.activity && participating(pending.digest) && budget.left > 0) { assigner.start(pending); result.started++; budget.left--; }
    else { assigner.mark(source, 'none'); result.none++; }
  }
  return result;
}

function narrativeMember(node: { id: string; title: string; summary: string; at: number | null; involvement: string; activity: string | null }): NarrativeMember {
  return { sourceId: node.id, title: node.title, summary: node.summary, at: node.at, involvement: node.involvement, activity: parse(node.activity) };
}

function clusterEntities(clustering: Clustering, members: number[]): NarrativeEntity[] {
  const support = new Map<number, number>();
  for (const i of members) for (const id of clustering.input.nodes[i]!.signals) support.set(id, (support.get(id) ?? 0) + 1);
  return [...support].map(([id, n]) => ({ id, name: clustering.input.names.get(id) ?? '', type: clustering.input.types.get(id) ?? '',
    idf: clustering.input.idf.get(id) ?? 0, support: n })).filter(entity => entity.name);
}

/** Title keys of open episodes other than `except`: a deterministic title must not collide (same-title episodes fold). */
export function openTitles(sdk: ShaleSDK, except?: number): Set<string> {
  return new Set(sdk.database.query<{ id: number; title: string }, []>(`SELECT g.entity_id AS id,coalesce(e.display_name,e.name) AS title
    FROM graph_episodes g JOIN entities e ON e.id=g.entity_id WHERE e.canonical_id IS NULL AND g.status!='closed'`).all()
    .filter(row => row.id !== except).map(row => fullNameKey(row.title)).filter((key): key is string => key !== null));
}

/** Deterministic narrative for an existing episode from its members and its defining members' signals. */
export function episodeNarrative(sdk: ShaleSDK, episode: number, members: Array<{ sourceId: string; title: string; summary: string; at: number | null }>,
  kind?: string, startedAt?: number | null): Narrative {
  const db = sdk.database;
  const digests = new Map(members.map(member => [member.sourceId, db.query<{ involvement: string; activity: string | null }, [string]>(
    'SELECT involvement,activity FROM graph_source_digests WHERE source_id=?').get(member.sourceId)]));
  const { defining, rows } = definingMembers(sdk, episode);
  const basis = (defining.length ? defining : rows).map(row => row.sourceId);
  const total = digestTotal(sdk), support = new Map<number, number>();
  for (const source of basis) for (const { entity_id } of db.query<{ entity_id: number }, [string]>('SELECT entity_id FROM graph_digest_signals WHERE source_id=?').all(source)) {
    const id = canonicalOf(db, entity_id);
    support.set(id, (support.get(id) ?? 0) + 1);
  }
  const entities = [...support].flatMap(([id, n]) => {
    const row = db.query<{ name: string; type: string; stable_id: string }, [number]>('SELECT coalesce(display_name,name) AS name,type,stable_id FROM entities WHERE id=?').get(id);
    return row && row.stable_id !== 'self' ? [{ id, name: row.name, type: row.type, idf: idf(sdk, id, total), support: n }] : [];
  });
  return narrate({
    members: members.map(member => ({ ...member, involvement: digests.get(member.sourceId)?.involvement ?? null, activity: parse(digests.get(member.sourceId)?.activity ?? null) })),
    // Support is counted over the defining members; narrate's 30% rule then applies to that same population.
    entities: entities.map(entity => ({ ...entity, support: Math.round(entity.support * members.length / Math.max(1, basis.length)) })),
    taken: openTitles(sdk, canonicalOf(db, episode)), kind, startedAt,
  });
}

export { CLUSTER_DEFAULTS };
