import type { ShaleSDK } from '@shale/sdk';
import type { EpisodeStore } from '../../sdk/graph/episodes';
import { canonicalOf, indexEntity } from '../../sdk/graph/registry';
import { SELF_STABLE_ID } from '../../sdk/graph/identity';
import { fullNameKey, words } from '../../lib/graph/identity-keys';
import { candidates, digestFor, digestTotal, idf, participating, sourceSignals, type Assigner } from './assign';

/**
 * What an episode matches on (its INVOLVES claims) comes only from the sources that define it: the trigger,
 * members whose activity label names the episode, members the model confirmed, and manual corrections.
 * Other members may join through those hooks but never add to them, so one weak match cannot pull in
 * Google, and with it every Google security alert. Hooks are re-derived as defining members come and go.
 */
const SINGLE_SOURCE_HOOKS = 8, MAX_HOOKS = 24, SUPPORT_SHARE = 0.15;
const RETRACT_REASON = "not supported by the episode's defining sources";

export interface MemberRow {
  claimId: string; sourceId: string; role: string; basis: string; method: string; confidence: number | null;
  involvement: string | null; activity: string | null;
}

function groupOf(sdk: ShaleSDK, episode: number): number[] {
  return sdk.database.query<{ id: number }, [number]>(`WITH RECURSIVE m(id) AS (SELECT ? UNION SELECT e.id FROM entities e
    JOIN m ON e.canonical_id=m.id) SELECT id FROM m`).all(canonicalOf(sdk.database, episode)).map(row => row.id);
}

const list = (ids: number[]) => ids.map(() => '?').join(',');
const labelOf = (row: Pick<MemberRow, 'activity'>) => {
  try { return row.activity ? (JSON.parse(row.activity) as { label?: unknown }).label as string | undefined : undefined; } catch { return undefined; }
};

/** Active members whose source still exists, with what their digests say. */
export function membersOf(sdk: ShaleSDK, episode: number): MemberRow[] {
  const ids = groupOf(sdk, episode);
  return sdk.database.query<MemberRow, number[]>(`SELECT c.id AS claimId,json_extract(c.qualifiers,'$.sourceId') AS sourceId,
      coalesce(json_extract(c.qualifiers,'$.role'),'progress') AS role,coalesce(json_extract(c.qualifiers,'$.basis'),'') AS basis,
      c.method,c.confidence,d.involvement,d.activity
    FROM graph_claims c JOIN sources s ON s.id=json_extract(c.qualifiers,'$.sourceId')
    LEFT JOIN graph_source_digests d ON d.source_id=s.id
    WHERE c.predicate='PART_OF_EPISODE' AND c.status IN ('accepted','proposed') AND c.object_id IN (${list(ids)})
    ORDER BY coalesce(c.valid_from,0),c.id`).all(...ids);
}

/** Names the episode is known by: display names and plain aliases across its identity group. */
function ownNames(sdk: ShaleSDK, ids: number[]): string[] {
  return sdk.database.query<{ name: string }, number[]>(`SELECT coalesce(display_name,name) AS name FROM entities WHERE id IN (${list(ids)})
    UNION SELECT alias FROM graph_aliases WHERE entity_id IN (${list(ids)}) AND scope=''`).all(...ids, ...ids).map(row => row.name);
}

const reviewed = (row: Pick<MemberRow, 'basis' | 'confidence'>) => row.basis.startsWith('model review') && (row.confidence ?? 0) >= 0.8;
/** Manual members and the model's confirmations are never pruned by the algorithm. */
export const protectedMember = (row: Pick<MemberRow, 'basis' | 'method'>) => row.method !== 'episode-assignment' || row.basis.startsWith('model review');

/** Members that define the episode, and the name keys (own names plus their labels) that identify it. */
export function definingMembers(sdk: ShaleSDK, episode: number) {
  const ids = groupOf(sdk, episode);
  const rows = membersOf(sdk, episode);
  const names = new Set(ownNames(sdk, ids).map(fullNameKey).filter((key): key is string => key !== null));
  const user = (row: MemberRow) => row.involvement === 'participant' || row.involvement === 'author';
  const base = (row: MemberRow) => row.role === 'trigger' || row.method !== 'episode-assignment'
    || (reviewed(row) && user(row) && Boolean(labelOf(row)));
  for (const row of rows) if (base(row)) { const key = fullNameKey(labelOf(row) ?? ''); if (key) names.add(key); }
  const defining = rows.filter(row => base(row) || names.has(fullNameKey(labelOf(row) ?? '') ?? ''));
  return { ids, rows, defining, names };
}

/** Whether a source joining with this label (and review verdict) would define the episode. */
export function wouldDefine(sdk: ShaleSDK, episode: number, label: string | undefined, basis: string, confidence: number, user: boolean) {
  if (basis.startsWith('model review') && confidence >= 0.8 && user && label) return true;
  const key = label ? fullNameKey(label) : null;
  return key !== null && definingMembers(sdk, episode).names.has(key);
}

function signalsOf(sdk: ShaleSDK, sourceId: string): number[] {
  const recorded = sdk.database.query<{ signals_at: number | null; entity_ids: string }, [string]>(
    'SELECT signals_at,entity_ids FROM graph_source_digests WHERE source_id=?').get(sourceId);
  if (!recorded) return [];
  const ids = recorded.signals_at === null ? sourceSignals(sdk, { source_id: sourceId, entity_ids: recorded.entity_ids })
    : sdk.database.query<{ entity_id: number }, [string]>('SELECT entity_id FROM graph_digest_signals WHERE source_id=?').all(sourceId)
      .map(row => row.entity_id);
  // Signals recorded before an account was merged into the user would otherwise make "me" a hook.
  const self = sdk.database.query<{ id: number }, [string]>('SELECT id FROM entities WHERE stable_id=?').get(SELF_STABLE_ID)?.id;
  const user = self === undefined ? null : canonicalOf(sdk.database, self);
  return [...new Set(ids.map(id => canonicalOf(sdk.database, id)))].filter(id => id !== user);
}

/** Whether an entity's name appears, word for word, in the episode title ("UWHPC" in "UWHPC Onboarding"). */
function namedIn(title: string[], name: string): boolean {
  const parts = words(name);
  if (!parts.length || parts.join('').length < 3) return false;
  for (let start = 0; start + parts.length <= title.length; start++)
    if (parts.every((part, index) => title[start + index] === part)) return true;
  return false;
}

/**
 * Re-derive an episode's INVOLVES claims from its defining members. With one defining source, its eight most
 * specific entities; with more, those carried by at least 15% of them (at least one), plus any entity the
 * title names. Only claims the assigner wrote are changed. Returns whether anything changed.
 */
export function refreshInvolvement(sdk: ShaleSDK, store: EpisodeStore, episode: number, total = digestTotal(sdk)): boolean {
  const db = sdk.database;
  const canonical = canonicalOf(db, episode);
  const { ids, rows, defining } = definingMembers(sdk, canonical);
  // An episode whose defining sources are all gone keeps matching on what its user-side members share.
  const basis = defining.length ? defining
    : rows.filter(row => row.involvement === 'participant' || row.involvement === 'author');
  const weight = new Map<number, number>(), support = new Map<number, number>();
  const ubiquitous = (value: number) => total >= 20 && value <= 0;
  const perSource = basis.map(row => signalsOf(sdk, row.sourceId).filter(id => {
    if (!weight.has(id)) weight.set(id, idf(sdk, id, total));
    return !ubiquitous(weight.get(id)!);
  }));
  for (const signals of perSource) for (const id of signals) support.set(id, (support.get(id) ?? 0) + 1);
  const title = words(db.query<{ name: string }, [number]>('SELECT coalesce(display_name,name) AS name FROM entities WHERE id=?')
    .get(canonical)?.name ?? '');
  const byWeight = (a: number, b: number) => (support.get(b)! - support.get(a)!) || (weight.get(b)! - weight.get(a)!);
  const need = Math.max(1, Math.ceil(SUPPORT_SHARE * basis.length));
  const kept = new Set(basis.length === 1 ? [...perSource[0]!].sort(byWeight).slice(0, SINGLE_SOURCE_HOOKS)
    : [...support.keys()].filter(id => support.get(id)! >= need).sort(byWeight).slice(0, MAX_HOOKS));
  for (const id of support.keys()) {
    const entity = db.query<{ name: string }, [number]>('SELECT coalesce(display_name,name) AS name FROM entities WHERE id=?').get(id);
    if (entity && namedIn(title, entity.name)) kept.add(id);
  }

  const claims = db.query<{ id: string; object_id: number; status: string; method: string }, number[]>(`SELECT id,object_id,status,method
    FROM graph_claims WHERE predicate='INVOLVES' AND subject_id IN (${list(ids)})`).all(...ids)
    .map(claim => ({ ...claim, object: canonicalOf(db, claim.object_id) }));
  let changed = false;
  for (const entity of kept) {
    const own = claims.filter(claim => claim.object === entity);
    if (entity === canonical || own.some(claim => claim.status === 'accepted')) continue;
    const dormant = own.find(claim => claim.method === 'episode-assignment' && claim.status === 'retracted');
    if (dormant) sdk.graph.lifecycle.review(dormant.id, 'accepted', 'episodes', "supported by the episode's defining sources");
    else if (!own.length) store.involve(canonical, entity, weight.get(entity)!);
    else continue; // Invalidated by the graph (stale, superseded): not the assigner's to restore.
    changed = true;
  }
  for (const claim of claims) if (claim.method === 'episode-assignment' && claim.status === 'accepted' && !kept.has(claim.object)) {
    sdk.graph.lifecycle.review(claim.id, 'retracted', 'episodes', RETRACT_REASON);
    changed = true;
  }
  return changed;
}

/**
 * Bring an episode back to what its defining sources support: re-derive its hooks, drop search aliases that
 * came from other pursuits, and detach ordinary members that no longer reach the attach score. Detached
 * sources return to `pending` and are placed again on their merits. Manual and model-confirmed members stay.
 */
export function auditEpisode(sdk: ShaleSDK, assigner: Assigner, episode: number, total = digestTotal(sdk)) {
  return sdk.database.transaction(() => {
    const canonical = canonicalOf(sdk.database, episode);
    let changed = refreshInvolvement(sdk, assigner.store, canonical, total);
    const { ids, rows, defining, names } = definingMembers(sdk, canonical);
    for (const alias of sdk.database.query<{ entity_id: number; alias: string }, number[]>(`SELECT entity_id,alias FROM graph_aliases
      WHERE scope='search' AND entity_id IN (${list(ids)})`).all(...ids)) {
      if (names.has(fullNameKey(alias.alias) ?? '')) continue;
      sdk.graph.entities.removeAlias(alias.entity_id, alias.alias, 'search');
      changed = true;
    }
    const keep = new Set(defining.map(row => row.claimId));
    let pruned = 0;
    // Without a defining source left there is nothing to measure members against; leave the episode whole.
    for (const row of defining.length ? rows : []) {
      // Members the clustering placed are re-judged by it each run (with hysteresis), not by the greedy score.
      if (keep.has(row.claimId) || protectedMember(row) || row.basis.startsWith('cluster ')) continue;
      const digest = digestFor(sdk, row.sourceId);
      if (!digest) continue;
      let activity = null;
      try { activity = digest.activity ? JSON.parse(digest.activity) : null; } catch { activity = null; }
      const score = candidates(sdk, digest, activity, assigner.settings, total).candidates.find(item => item.episode === canonical)?.score ?? 0;
      const attachAt = participating(digest) ? assigner.settings.attachScore : assigner.settings.attachScore * 1.5;
      if (score >= attachAt) continue;
      assigner.store.detach(canonical, row.sourceId, 'episodes', `${RETRACT_REASON} (score ${score.toFixed(2)})`);
      sdk.database.query("UPDATE graph_source_digests SET episode_state='pending',episode_checked_at=? WHERE source_id=?")
        .run(Date.now(), row.sourceId);
      pruned++;
    }
    if (changed && !pruned) sdk.database.query('UPDATE graph_episodes SET updated_at=? WHERE entity_id=?').run(Date.now(), canonical);
    if (changed || pruned) indexEntity(sdk.database, canonical);
    return { changed: changed || pruned > 0, pruned };
  }).immediate();
}

/** Audit every open episode; returns how many members were detached. */
export function auditOpenEpisodes(sdk: ShaleSDK, assigner: Assigner, only?: Iterable<number>): number {
  const total = digestTotal(sdk);
  const episodes = only ? [...new Set([...only].map(id => canonicalOf(sdk.database, id)))]
    : sdk.database.query<{ id: number }, []>(`SELECT g.entity_id AS id FROM graph_episodes g JOIN entities e ON e.id=g.entity_id
      WHERE e.canonical_id IS NULL AND g.status!='closed' ORDER BY g.entity_id`).all().map(row => row.id);
  let pruned = 0;
  for (const episode of episodes) pruned += auditEpisode(sdk, assigner, episode, total).pruned;
  return pruned;
}
