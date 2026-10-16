import type { Database } from 'bun:sqlite';
import { canonicalRoots, hasTable, optionalExport } from './common';
import type { Assignment } from './clustering';

/**
 * Episode replay. The reference is today's active membership (accepted/proposed PART_OF_EPISODE claims,
 * episodes resolved to their merge root); a candidate clustering is compared with clusterAgreement.
 *
 * Clusterer contract (phase P4 plugs in here): a module exporting
 *   clusterEpisodes(db: Database): Assignment | Promise<Assignment>     // Map<sourceId, clusterId>
 * Cluster ids are opaque; only co-membership is compared.
 */
export type EpisodeClusterer = (db: Database) => Assignment | Promise<Assignment>;

export function referenceMembership(db: Database): { assignment: Assignment; multi: number } {
  if (!hasTable(db, 'graph_claims')) return { assignment: new Map(), multi: 0 };
  const root = canonicalRoots(db);
  const rows = db.query<{ source: string; episode: number; confidence: number | null }, []>(`SELECT json_extract(qualifiers,'$.sourceId') AS source,
    object_id AS episode,confidence FROM graph_claims WHERE predicate='PART_OF_EPISODE' AND status IN ('accepted','proposed')
    AND json_extract(qualifiers,'$.sourceId') IS NOT NULL ORDER BY coalesce(confidence,0) DESC,recorded_at DESC`).all();
  const assignment: Assignment = new Map(), episodes = new Map<string, Set<number>>();
  for (const row of rows) {
    const episode = root(row.episode);
    (episodes.get(row.source) ?? episodes.set(row.source, new Set()).get(row.source)!).add(episode);
    // Hard clustering: a source in two episodes counts in its most confident one; `multi` reports how often that happens.
    if (!assignment.has(row.source)) assignment.set(row.source, episode);
  }
  return { assignment, multi: [...episodes.values()].filter(set => set.size > 1).length };
}

/** Today's episode health: fragmentation, cross-origin reach, and which path attached members. */
export function episodeBaseline(db: Database) {
  if (!hasTable(db, 'graph_episodes')) return null;
  const count = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n;
  const basis = db.query<{ basis: string; n: number }, []>(`SELECT CASE WHEN basis GLOB 'model review*' THEN 'model review'
      WHEN basis GLOB 'score*' THEN 'score' WHEN basis GLOB 'label *' THEN 'label' ELSE coalesce(basis,'(none)') END AS basis,count(*) AS n
    FROM (SELECT json_extract(qualifiers,'$.basis') AS basis FROM graph_claims WHERE predicate='PART_OF_EPISODE' AND status IN ('accepted','proposed'))
    GROUP BY 1 ORDER BY n DESC`).all();
  const states = db.query<{ state: string; n: number }, []>('SELECT episode_state AS state,count(*) AS n FROM graph_source_digests GROUP BY 1 ORDER BY n DESC').all();
  return {
    episodes: count("SELECT count(*) AS n FROM graph_episodes g JOIN entities e ON e.id=g.entity_id WHERE e.canonical_id IS NULL"),
    membershipByBasis: Object.fromEntries(basis.map(row => [row.basis, row.n])),
    digestEpisodeStates: Object.fromEntries(states.map(row => [row.state, row.n])),
  };
}

/** Trivial deterministic clusterings that bound what structure alone achieves. */
export const BASELINES: Record<string, EpisodeClusterer> = {
  /** Every source alone: pairwise recall 0, B-cubed precision 1. */
  singletons: db => new Map(db.query<{ id: string }, []>('SELECT id FROM sources').all().map(row => [row.id, row.id])),
  /** One cluster per connector thread/conversation/page (uri without its #window fragment). */
  'same-thread': db => new Map(db.query<{ id: string; uri: string }, []>('SELECT id,uri FROM sources').all()
    .map(row => [row.id, row.uri.replace(/#.*$/, '')])),
};

export async function loadClusterer(modulePath?: string) {
  const paths = modulePath ? [modulePath] : ['lib/graph/cluster.ts', 'lib/graph/episode-clusters.ts', 'extensions/episodes/cluster.ts'];
  return optionalExport<EpisodeClusterer>(paths, ['clusterEpisodes']);
}
