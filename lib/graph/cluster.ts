import type { Database } from 'bun:sqlite';
import { contract, leiden, type Edge } from './leiden';
import { hungarian } from './hungarian';

/**
 * Episodes as temporal graph clustering (plan P4). Instead of placing each source greedily against the
 * episodes that exist at that moment, cluster every digested source at once:
 *
 *   1. Affinity graph. w(a,b) = Σ_{shared canonical signal e} idf(e)·typeWeight(e) · exp(−|Δt|/τ), with the
 *      signals and idf semantics of extensions/episodes/assign.ts (graph_digest_signals; merged identities
 *      counted together; the user and ubiquitous entities weigh nothing). An optional `bonus(a,b)` hook adds
 *      template-sequence evidence (same sender organisation, successive stages) once P2 provides it.
 *   2. Constraints. Must-links: one email thread / chat conversation, one URL, Obsidian wikilinks (hub notes
 *      excepted), and optionally the protected members of each existing episode. Cannot-links: manual
 *      detachments and undone episode merges.
 *   3. Constrained Leiden (CPM, resolution γ), then temporal segmentation at gaps longer than dormantDays.
 *   4. Pursuit rule: a cluster becomes an episode only with a participant/author source; observer-only
 *      clusters attach as context to the nearest pursuit cluster when the affinity suffices.
 *   5. Hungarian matching of clusters to existing Episode entities on member overlap, so ids stay stable.
 *
 * Read-only: safe on a readonly connection (offline evaluation) and inside the episodes cron.
 */
const DAY = 86_400_000;
const SELF_STABLE_ID = 'self'; // sdk/graph/identity.ts SELF_STABLE_ID; not imported to keep lib free of the SDK
/** Actors whose detachments are the algorithm's own; anything else (MCP, UI, a person) is a manual correction. */
export const ALGORITHM_ACTORS = new Set(['episodes', 'episodes-cluster']);
/** Conversation must-links only where a conversation is one thread, not a venue (a Discord channel is a venue). */
const THREAD_NAMESPACES = new Set(['email', 'ai-chats']);
const THREAD_ORIGINS = new Set(['email', 'chatgpt', 'claude', 'gemini']);

export interface ClusterOptions {
  /** CPM resolution γ: affinity needed per pair of members for two groups to join. */
  resolution?: number;
  /** Temporal kernel scale in days: sources this far apart count e^-1 ≈ 37% as much. */
  tauDays?: number;
  /** Split a cluster where its members go quiet for longer than this. */
  dormantDays?: number;
  seed?: number;
  /** Signals in more sources than this generate no pairs (bounded work; their idf is small anyway). */
  maxDf?: number;
  /** Multiplier per entity type; footer links and social profiles repeat across a sender's mail. */
  typeWeights?: Record<string, number>;
  /** Jaccard of source sets at which signals count as one piece of evidence (1 disables grouping). */
  groupThreshold?: number;
  /** A pursuit cluster needs a participant/author source whose digest carries an activity (what the user is doing). */
  pursuitNeedsActivity?: boolean;
  /** Factor for pairs whose only link is a single evidence group. */
  singleEvidence?: number;
  /** Mean affinity per observer source needed to attach an observer-only cluster as context. */
  contextAffinity?: number;
  /** Notes with more wikilinks among digested notes than this are hubs: their links are evidence, not must-links. */
  wikilinkHub?: number;
  /** Contract each existing episode's protected members (manual, model-confirmed, closed) into one unit. */
  protectExisting?: boolean;
  /** Optional template-sequence evidence between two sources (P2 hook). */
  bonus?: (a: SourceNode, b: SourceNode) => number;
}

export const CLUSTER_DEFAULTS = {
  resolution: 1.5, tauDays: 60, dormantDays: 45, seed: 42, maxDf: 250, contextAffinity: 3, wikilinkHub: 15, groupThreshold: 0.3, singleEvidence: 0.5, pursuitNeedsActivity: true,
  protectExisting: false,
  typeWeights: { WebPage: 0.1, Person: 0.8, Place: 0.2, Concept: 0.6, Product: 0.8, Conversation: 1, Server: 0.5 } as Record<string, number>,
};

export interface SourceNode {
  id: string; at: number | null; involvement: string; origin: string; title: string; summary: string; activity: string | null;
  /** The source row still exists (a removed source keeps its digest and memberships, but cannot gain new ones). */
  present: boolean;
  signals: number[];
}
export interface Membership { episode: number; claimId: string; protected: boolean; basis: string }
export interface AffinityInput {
  nodes: SourceNode[];
  idf: Map<number, number>;
  types: Map<number, string>;
  names: Map<number, string>;
  must: Array<[number, number]>;
  cannot: Array<[number, number]>;
  /** Active membership by source (episodes resolved to their merge root). */
  membership: Map<string, Membership[]>;
  /** Open/dormant/closed canonical episodes. */
  episodes: Map<number, { title: string; kind: string; status: string; startedAt: number | null }>;
  /** Sources manually detached from an episode (root): never placed back automatically. */
  detached: Map<string, Set<number>>;
  /** Episode pairs a merge of which was undone. */
  separated: Array<[number, number]>;
}
export interface Cluster {
  key: string;
  /** Node indices of the pursuit members (or the whole cluster when not a pursuit). */
  members: number[];
  /** Observer-only clusters attached to this one as context. */
  context: number[];
  pursuit: boolean;
  /** Existing episode this cluster continues (Hungarian on member overlap), or null for a new one. */
  episode: number | null;
  overlap: number;
}
export interface Clustering {
  input: AffinityInput;
  options: typeof CLUSTER_DEFAULTS & ClusterOptions;
  clusters: Cluster[];
  /** Node index → cluster index (pursuit cluster for attached context), or -1. */
  clusterOf: number[];
  /** Affinity between two nodes (0 when not adjacent). */
  affinity: (a: number, b: number) => number;
  /** Mean affinity of node i to a set of nodes (excluding itself). */
  affinityTo: (i: number, nodes: number[]) => number;
  /** Whether i shares at least two independent pieces of evidence with some node of the set. */
  corroborated: (i: number, nodes: number[]) => boolean;
  edges: Edge[];
}

/** Entity id → root of its merge group. */
function roots(db: Database) {
  const parent = new Map<number, number>();
  for (const row of db.query<{ id: number; canonical_id: number }, []>('SELECT id,canonical_id FROM entities WHERE canonical_id IS NOT NULL').all())
    parent.set(row.id, row.canonical_id);
  const memo = new Map<number, number>();
  return (id: number) => {
    const known = memo.get(id); if (known !== undefined) return known;
    let at = id; const seen = new Set<number>();
    while (parent.has(at) && !seen.has(at)) { seen.add(at); at = parent.get(at)!; }
    memo.set(id, at); return at;
  };
}

const participating = (involvement: string) => involvement === 'participant' || involvement === 'author';
const has = (db: Database, table: string) => Boolean(db.query("SELECT 1 FROM sqlite_master WHERE name=?").get(table));

/** Read everything the clustering needs in a handful of queries. */
export function loadAffinityInput(db: Database, options: ClusterOptions = {}): AffinityInput {
  const opts = { ...CLUSTER_DEFAULTS, ...options };
  const root = roots(db);
  const empty: AffinityInput = { nodes: [], idf: new Map(), types: new Map(), names: new Map(), must: [], cannot: [], membership: new Map(),
    episodes: new Map(), detached: new Map(), separated: [] };
  if (!has(db, 'graph_source_digests') || !has(db, 'graph_digest_signals')) return empty;
  const rows = db.query<Omit<SourceNode, 'signals' | 'at' | 'present'> & { occurred_from: number | null; occurred_to: number | null; created_at: number | null; present: number }, []>(`
    SELECT d.source_id AS id,d.occurred_from,d.occurred_to,d.involvement,d.summary,d.activity,coalesce(s.origin,'') AS origin,
      coalesce(s.title,'') AS title,s.created_at,s.id IS NOT NULL AS present
    FROM graph_source_digests d LEFT JOIN sources s ON s.id=d.source_id WHERE d.signals_at IS NOT NULL ORDER BY d.source_id`).all();
  const index = new Map<string, number>();
  const nodes: SourceNode[] = rows.map((row, i) => {
    index.set(row.id, i);
    return { id: row.id, at: row.occurred_from ?? row.occurred_to ?? row.created_at ?? null, involvement: row.involvement, origin: row.origin,
      title: row.title, summary: row.summary, activity: row.activity, present: Boolean(row.present), signals: [] };
  });
  const self = db.query<{ id: number }, [string]>('SELECT id FROM entities WHERE stable_id=?').get(SELF_STABLE_ID)?.id;
  const selfRoot = self === undefined ? null : root(self);
  const signals = nodes.map(() => new Set<number>());
  for (const row of db.query<{ source_id: string; entity_id: number }, []>('SELECT source_id,entity_id FROM graph_digest_signals').all()) {
    const i = index.get(row.source_id);
    if (i === undefined) continue;
    const id = root(row.entity_id);
    if (id !== selfRoot) signals[i]!.add(id);
  }
  const df = new Map<number, number>();
  nodes.forEach((node, i) => { node.signals = [...signals[i]!].sort((a, b) => a - b); for (const id of node.signals) df.set(id, (df.get(id) ?? 0) + 1); });
  const total = nodes.length, idf = new Map<number, number>();
  // assign.ts idf(): ubiquitous entities (in half of everything) say nothing about which story a source belongs to.
  for (const [id, n] of df) idf.set(id, total >= 20 && n / total > 0.5 ? 0 : Math.log(1 + total / Math.max(1, n)));
  const types = new Map<number, string>(), names = new Map<number, string>();
  for (const row of db.query<{ id: number; type: string; name: string }, []>(
    'SELECT id,type,coalesce(display_name,name) AS name FROM entities WHERE canonical_id IS NULL').all()) {
    if (!df.has(row.id)) continue;
    types.set(row.id, row.type); names.set(row.id, row.name);
  }

  // Structural must-links. Record entities stand for sources (alias scope 'source-id').
  const must: Array<[number, number]> = [];
  const recordOf = new Map<number, number>();
  for (const row of db.query<{ entity_id: number; alias: string }, []>("SELECT entity_id,alias FROM graph_aliases WHERE scope='source-id'").all()) {
    const i = index.get(row.alias);
    if (i !== undefined) recordOf.set(row.entity_id, i);
  }
  const groupBy = (keyed: Array<[string, number]>) => {
    const first = new Map<string, number>();
    for (const [key, i] of keyed) { const head = first.get(key); if (head === undefined) first.set(key, i); else if (head !== i) must.push([head, i]); }
  };
  if (has(db, 'graph_claims')) {
    const threads: Array<[string, number]> = [];
    for (const row of db.query<{ subject_id: number; object_id: number; namespace: string }, []>(`SELECT subject_id,object_id,namespace FROM graph_claims
      WHERE predicate='IN_CONVERSATION' AND status IN ('accepted','proposed') AND object_id IS NOT NULL`).all()) {
      const i = recordOf.get(row.subject_id);
      if (i !== undefined && THREAD_NAMESPACES.has(row.namespace)) threads.push([`c:${root(row.object_id)}`, i]);
    }
    groupBy(threads);
    // Wikilinks between digested notes; links of hub notes (an index page) would chain the whole vault.
    const links = db.query<{ subject_id: number; object_id: number }, []>(`SELECT subject_id,object_id FROM graph_claims
      WHERE predicate='REFERENCES' AND namespace='obsidian' AND status IN ('accepted','proposed') AND object_id IS NOT NULL`).all()
      .flatMap(row => { const a = recordOf.get(row.subject_id), b = recordOf.get(row.object_id); return a !== undefined && b !== undefined && a !== b ? [[a, b] as [number, number]] : []; });
    const degree = new Map<number, number>();
    for (const [a, b] of links) { degree.set(a, (degree.get(a) ?? 0) + 1); degree.set(b, (degree.get(b) ?? 0) + 1); }
    for (const [a, b] of links) if (degree.get(a)! <= opts.wikilinkHub && degree.get(b)! <= opts.wikilinkHub) must.push([a, b]);
  }
  const uris: Array<[string, number]> = [];
  for (const row of db.query<{ id: string; uri: string; origin: string }, []>(`SELECT s.id,s.uri,s.origin FROM sources s
    JOIN graph_source_digests d ON d.source_id=s.id WHERE d.signals_at IS NOT NULL`).all()) {
    const i = index.get(row.id)!;
    // Thread-like origins window one conversation (#window=…); elsewhere the fragment names a different page.
    uris.push([`u:${THREAD_ORIGINS.has(row.origin) ? row.uri.replace(/#.*$/, '') : row.uri}`, i]);
  }
  groupBy(uris);

  // Current episodes and memberships.
  const episodes = new Map<number, { title: string; kind: string; status: string; startedAt: number | null }>();
  const membership = new Map<string, Membership[]>();
  const detached = new Map<string, Set<number>>();
  const separated: Array<[number, number]> = [];
  if (has(db, 'graph_episodes')) {
    for (const row of db.query<{ id: number; title: string; kind: string; status: string; started_at: number | null }, []>(`
      SELECT g.entity_id AS id,coalesce(e.display_name,e.name) AS title,g.kind,g.status,g.started_at FROM graph_episodes g
      JOIN entities e ON e.id=g.entity_id WHERE e.canonical_id IS NULL`).all())
      episodes.set(row.id, { title: row.title, kind: row.kind, status: row.status, startedAt: row.started_at });
    for (const row of db.query<{ id: string; source: string; episode: number; method: string; basis: string | null }, []>(`
      SELECT id,json_extract(qualifiers,'$.sourceId') AS source,object_id AS episode,method,json_extract(qualifiers,'$.basis') AS basis
      FROM graph_claims WHERE predicate='PART_OF_EPISODE' AND status IN ('accepted','proposed') AND json_extract(qualifiers,'$.sourceId') IS NOT NULL
      ORDER BY id`).all()) {
      const episode = root(row.episode), basis = row.basis ?? '';
      const meta = episodes.get(episode);
      // involvement.ts protectedMember(), plus everything in a closed episode (finished stories stay as they are).
      const isProtected = row.method !== 'episode-assignment' || basis.startsWith('model review') || meta?.status === 'closed';
      (membership.get(row.source) ?? membership.set(row.source, []).get(row.source)!).push({ episode, claimId: row.id, protected: isProtected, basis });
    }
    // Manual detachments: the last review of a retracted membership was not the algorithm's.
    for (const row of db.query<{ source: string; episode: number; actor: string }, []>(`
      SELECT json_extract(c.qualifiers,'$.sourceId') AS source,c.object_id AS episode,
        (SELECT r.actor FROM graph_reviews r WHERE r.claim_id=c.id ORDER BY r.reviewed_at DESC,r.id DESC LIMIT 1) AS actor
      FROM graph_claims c WHERE c.predicate='PART_OF_EPISODE' AND c.status='retracted'`).all()) {
      if (!row.source || !row.actor || ALGORITHM_ACTORS.has(row.actor)) continue;
      (detached.get(row.source) ?? detached.set(row.source, new Set()).get(row.source)!).add(root(row.episode));
    }
    if (has(db, 'graph_identity_changes')) for (const row of db.query<{ a: number; b: number }, []>(`SELECT c.entity_id AS a,c.canonical_id AS b
      FROM graph_identity_changes c JOIN entities x ON x.id=c.entity_id JOIN entities y ON y.id=c.canonical_id
      WHERE c.undone_at IS NOT NULL AND x.type='Episode' AND y.type='Episode'`).all()) separated.push([root(row.a), root(row.b)]);
  }

  // Cannot-links: a manually detached source vs the episode's current members; members of separated episodes.
  const cannot: Array<[number, number]> = [];
  const membersOf = new Map<number, number[]>();
  for (const [source, list] of membership) {
    const i = index.get(source);
    if (i !== undefined) for (const m of list) (membersOf.get(m.episode) ?? membersOf.set(m.episode, []).get(m.episode)!).push(i);
  }
  for (const [source, set] of detached) {
    const i = index.get(source);
    if (i !== undefined) for (const episode of set) for (const j of membersOf.get(episode) ?? []) if (j !== i) cannot.push([i, j]);
  }
  for (const [a, b] of separated) if (a !== b) for (const i of membersOf.get(a) ?? []) for (const j of membersOf.get(b) ?? []) if (i !== j) cannot.push([i, j]);
  if (opts.protectExisting) for (const [, list] of membersOf) {
    const anchored = list.filter(i => membership.get(nodes[i]!.id)!.some(m => m.protected && membersOf.get(m.episode) === list));
    for (let k = 1; k < anchored.length; k++) must.push([anchored[0]!, anchored[k]!]);
  }
  return { nodes, idf, types, names, must, cannot, membership, episodes, detached, separated };
}

/**
 * Group signals that travel together: a sender's organisation, address, footer links, and social profiles
 * appear in every one of its emails, and summing them would count one fact ("same sender") eight times.
 * Signals whose source sets overlap with Jaccard ≥ `threshold` form one evidence group, worth its strongest
 * member. Greedy from the most frequent signal, so a group's head is its most general member.
 */
export function evidenceGroups(postings: Map<number, number[]>, threshold: number): Map<number, number> {
  const group = new Map<number, number>();
  const sets = new Map<number, Set<number>>();
  for (const [id, list] of postings) if (list.length >= 2) sets.set(id, new Set(list));
  // Candidate partners co-occur in at least one source.
  const bySource = new Map<number, number[]>();
  for (const [id, list] of postings) if (list.length >= 2) for (const i of list) (bySource.get(i) ?? bySource.set(i, []).get(i)!).push(id);
  const order = [...sets.keys()].sort((a, b) => sets.get(b)!.size - sets.get(a)!.size || a - b);
  for (const head of order) {
    if (group.has(head)) continue;
    group.set(head, head);
    const own = sets.get(head)!;
    const seen = new Set<number>();
    for (const i of own) for (const other of bySource.get(i) ?? []) {
      if (seen.has(other) || group.has(other)) continue;
      seen.add(other);
      const set = sets.get(other)!;
      let both = 0;
      for (const j of set) if (own.has(j)) both++;
      if (both / (own.size + set.size - both) >= threshold) group.set(other, head);
    }
  }
  return group;
}

/** Pairwise affinity edges via an inverted index over signals; bounded by maxDf. */
export function affinityEdges(input: AffinityInput, options: ClusterOptions = {}): Edge[] {
  const opts = { ...CLUSTER_DEFAULTS, ...options, typeWeights: { ...CLUSTER_DEFAULTS.typeWeights, ...options.typeWeights } };
  const postings = new Map<number, number[]>();
  input.nodes.forEach((node, i) => { for (const id of node.signals) (postings.get(id) ?? postings.set(id, []).get(id)!).push(i); });
  const groups = opts.groupThreshold < 1 ? evidenceGroups(postings, opts.groupThreshold) : new Map<number, number>();
  // Per pair and evidence group, the strongest shared signal.
  const shared = new Map<number, Map<number, number>>(); // a*n+b → group → weight
  const n = input.nodes.length;
  for (const [id, list] of postings) {
    const weight = (input.idf.get(id) ?? 0) * (opts.typeWeights[input.types.get(id) ?? ''] ?? 1);
    if (weight <= 0 || list.length < 2 || list.length > opts.maxDf) continue;
    const group = groups.get(id) ?? id;
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const key = list[x]! * n + list[y]!;
      const pair = shared.get(key) ?? shared.set(key, new Map()).get(key)!;
      if ((pair.get(group) ?? 0) < weight) pair.set(group, weight);
    }
  }
  const tau = opts.tauDays * DAY, edges: Edge[] = [];
  const kernel = (a: SourceNode, b: SourceNode) => a.at === null || b.at === null ? 0.5 : Math.exp(-Math.abs(a.at - b.at) / tau);
  for (const [key, pair] of shared) {
    const a = Math.floor(key / n), b = key % n;
    let sum = 0;
    for (const weight of pair.values()) sum += weight;
    // One shared fact (both mention Python, or Princeton) is often incidental; corroborated links count fully.
    if (pair.size === 1) sum *= opts.singleEvidence;
    const w = sum * kernel(input.nodes[a]!, input.nodes[b]!) + (opts.bonus?.(input.nodes[a]!, input.nodes[b]!) ?? 0);
    if (w > 1e-3) edges.push({ a, b, w, evidence: pair.size });
  }
  if (opts.bonus) for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    if (shared.has(a * n + b)) continue;
    const w = opts.bonus(input.nodes[a]!, input.nodes[b]!);
    if (w > 1e-3) edges.push({ a, b, w });
  }
  return edges.sort((x, y) => x.a - y.a || x.b - y.b);
}

/**
 * Split one cluster where its members go quiet for longer than `gap`. Must-link units move together; undated
 * units stay with the segment holding most members. Returns groups of node indices.
 */
export function segment(members: number[], at: (i: number) => number | null, unit: (i: number) => number, gap: number): number[][] {
  const units = new Map<number, { nodes: number[]; from: number | null; to: number | null }>();
  for (const i of members) {
    const u = units.get(unit(i)) ?? units.set(unit(i), { nodes: [], from: null, to: null }).get(unit(i))!;
    u.nodes.push(i);
    const t = at(i);
    if (t !== null) { u.from = u.from === null ? t : Math.min(u.from, t); u.to = u.to === null ? t : Math.max(u.to, t); }
  }
  const dated = [...units.values()].filter(u => u.from !== null).sort((a, b) => a.from! - b.from! || a.nodes[0]! - b.nodes[0]!);
  const undated = [...units.values()].filter(u => u.from === null).flatMap(u => u.nodes);
  const segments: number[][] = [];
  let end = -Infinity;
  for (const u of dated) {
    if (!segments.length || u.from! - end > gap) segments.push([]);
    segments[segments.length - 1]!.push(...u.nodes);
    end = Math.max(end, u.to!);
  }
  if (undated.length) {
    if (!segments.length) segments.push([]);
    segments.reduce((a, b) => b.length > a.length ? b : a).push(...undated);
  }
  return segments.map(s => s.sort((a, b) => a - b));
}

/** Cluster sources: constrained Leiden → temporal segmentation → pursuit rule → Hungarian mapping. Pure over its input. */
export function clusterSources(input: AffinityInput, options: ClusterOptions = {}): Clustering {
  const opts = { ...CLUSTER_DEFAULTS, ...options, typeWeights: { ...CLUSTER_DEFAULTS.typeWeights, ...options.typeWeights } };
  const n = input.nodes.length;
  const edges = affinityEdges(input, opts);
  const adjacency = Array.from({ length: n }, () => new Map<number, number>());
  for (const { a, b, w } of edges) { adjacency[a]!.set(b, w); adjacency[b]!.set(a, w); }
  const affinity = (a: number, b: number) => adjacency[a]!.get(b) ?? 0;
  const strong = new Set(edges.filter(e => (e.evidence ?? 1) >= 2).map(e => e.a * n + e.b));
  const corroborated = (i: number, nodes: number[]) => nodes.some(j => j !== i && strong.has(Math.min(i, j) * n + Math.max(i, j)));
  const affinityTo = (i: number, nodes: number[]) => {
    const others = nodes.filter(j => j !== i);
    return others.length ? others.reduce((sum, j) => sum + affinity(i, j), 0) / others.length : 0;
  };
  const labels = leiden(n, edges, { resolution: opts.resolution, seed: opts.seed, must: input.must, cannot: input.cannot });
  const unit = contract(n, input.must, input.cannot);
  const byLabel = new Map<number, number[]>();
  labels.forEach((label, i) => (byLabel.get(label) ?? byLabel.set(label, []).get(label)!).push(i));
  const groups = [...byLabel.values()].flatMap(members => segment(members, i => input.nodes[i]!.at, i => unit[i]!, opts.dormantDays * DAY));

  // Pursuit rule: only clusters with the user taking part become episodes.
  // Pursuit rule: the user takes part in at least one source, and (by default) its digest names what the user is
  // doing. "Participant" alone also covers every notification addressed to the user (security alerts, digests).
  const pursuing = (i: number) => participating(input.nodes[i]!.involvement) && (!opts.pursuitNeedsActivity || Boolean(input.nodes[i]!.activity));
  const pursuits = groups.filter(group => group.some(pursuing));
  const observers = groups.filter(group => !group.some(pursuing));
  const clusters: Cluster[] = pursuits.map(members => ({ key: '', members, context: [], pursuit: true, episode: null, overlap: 0 }));
  const conflicts = new Map<number, Set<number>>();
  for (const [a, b] of input.cannot) { (conflicts.get(a) ?? conflicts.set(a, new Set()).get(a)!).add(b); (conflicts.get(b) ?? conflicts.set(b, new Set()).get(b)!).add(a); }
  const blocked = (group: number[], target: number[]) => group.some(i => target.some(j => conflicts.get(i)?.has(j)));
  const clusterOf = new Array<number>(n).fill(-1);
  clusters.forEach((cluster, c) => { for (const i of cluster.members) clusterOf[i] = c; });
  for (const group of observers) {
    // Nearest pursuit cluster by total affinity, normalised per observer source.
    const totals = new Map<number, number>();
    for (const i of group) for (const [j, w] of adjacency[i]!) if (clusterOf[j]! >= 0 && clusters[clusterOf[j]!]!.pursuit && !group.includes(j))
      totals.set(clusterOf[j]!, (totals.get(clusterOf[j]!) ?? 0) + w);
    let best = -1, bestValue = 0;
    for (const [c, total] of totals) {
      const value = total / group.length;
      if (value > bestValue && !blocked(group, [...clusters[c]!.members, ...clusters[c]!.context])) { best = c; bestValue = value; }
    }
    if (best >= 0 && bestValue >= opts.contextAffinity) {
      clusters[best]!.context.push(...group);
      for (const i of group) clusterOf[i] = best;
    } else clusters.push({ key: '', members: group, context: [], pursuit: false, episode: null, overlap: 0 });
  }
  for (let c = 0; c < clusters.length; c++) for (const i of clusters[c]!.members) clusterOf[i] = c;
  mapToEpisodes(input, clusters);
  clusters.forEach((cluster, c) => { cluster.key = cluster.episode !== null ? `episode:${cluster.episode}` : `cluster:${input.nodes[cluster.members[0]!]!.id}`; void c; });
  return { input, options: opts, clusters, clusterOf, affinity, affinityTo, corroborated, edges };
}

/**
 * Keep ids stable: match pursuit clusters to existing open episodes by maximum total member overlap
 * (Hungarian). Ties prefer the older episode, so a merge keeps the original story's id.
 */
export function mapToEpisodes(input: AffinityInput, clusters: Cluster[]) {
  const rows: number[] = [], columns: number[] = [], column = new Map<number, number>();
  const overlap: Array<Map<number, number>> = clusters.map(() => new Map());
  clusters.forEach((cluster, c) => {
    if (!cluster.pursuit) return;
    for (const i of [...cluster.members, ...cluster.context]) for (const m of input.membership.get(input.nodes[i]!.id) ?? []) {
      if (input.episodes.get(m.episode)?.status === 'closed') continue;
      overlap[c]!.set(m.episode, (overlap[c]!.get(m.episode) ?? 0) + 1);
    }
    if (overlap[c]!.size) rows.push(c);
  });
  for (const c of rows) for (const episode of overlap[c]!.keys()) if (!column.has(episode)) { column.set(episode, columns.length); columns.push(episode); }
  if (!rows.length) return;
  // Older episodes (lower start, then lower id) get a tie-breaking epsilon far below one member.
  const order = [...columns].sort((a, b) => (input.episodes.get(a)?.startedAt ?? Infinity) - (input.episodes.get(b)?.startedAt ?? Infinity) || a - b);
  const rank = new Map(order.map((episode, k) => [episode, k]));
  const matrix = rows.map(c => columns.map(episode => {
    const value = overlap[c]!.get(episode) ?? 0;
    return value ? value + 1e-3 * (1 - rank.get(episode)! / Math.max(1, columns.length)) : 0;
  }));
  for (const [r, k] of hungarian(matrix)) {
    const cluster = clusters[rows[r]!]!;
    cluster.episode = columns[k]!;
    cluster.overlap = overlap[rows[r]!]!.get(columns[k]!)!;
  }
}

/** Plug-in for scripts/llm-replacement-eval.ts: source id → cluster key, for sources placed in a pursuit cluster. */
export function clusterEpisodes(db: Database, options: ClusterOptions = {}): Map<string, string> {
  const clustering = clusterSources(loadAffinityInput(db, options), options);
  const out = new Map<string, string>();
  for (const cluster of clustering.clusters) {
    if (!cluster.pursuit) continue;
    for (const i of [...cluster.members, ...cluster.context]) out.set(clustering.input.nodes[i]!.id, cluster.key);
  }
  return out;
}
