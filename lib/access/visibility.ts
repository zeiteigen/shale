import type { Database, SQLQueryBindings } from "bun:sqlite";
import { SECRET, tierIndex, type AccessPolicy, type ResolvedProfile, type SourceMatch } from "./policy";
import { REVISION_CONTENT_HASH_SQL } from "./revision-classify";
import { LIVE_SOURCE_CONTENT_HASH_SQL, sourceContentHashSql } from "./source-hash";

/** Temp tables holding the ids a profile may see; `prefix` keeps reader and write-guard sets apart. */
export const VISIBLE_SETS = {
  sources: "id TEXT PRIMARY KEY",
  archives: "id TEXT PRIMARY KEY",
  revisions: "id INTEGER PRIMARY KEY",
  chunks: "id INTEGER PRIMARY KEY",
  texts: "id INTEGER PRIMARY KEY",
  entities: "id INTEGER PRIMARY KEY",
  claims: "id TEXT PRIMARY KEY",
  evidence: "id TEXT PRIMARY KEY",
} as const;
export type VisibleSet = keyof typeof VISIBLE_SETS;

export function visibleTable(prefix: string, set: VisibleSet) {
  return `temp.${prefix}_${set}`;
}

interface SourceColumns { origin: string; type: string; uri: string }

function matchSql(match: SourceMatch, columns: SourceColumns, params: SQLQueryBindings[]) {
  const parts: string[] = [];
  for (const key of ["origin", "type", "uri"] as const) {
    if (match[key] === undefined) continue;
    parts.push(`${columns[key]} GLOB ?`);
    params.push(match[key]!);
  }
  return `(${parts.join(" AND ")})`;
}

/** Configured floor: first matching tier rule, then the origin's tier, then the default. */
function configTierSql(policy: AccessPolicy, columns: SourceColumns, params: SQLQueryBindings[]) {
  const cases: string[] = [];
  for (const rule of policy.tierRules) cases.push(`WHEN ${matchSql(rule.match, columns, params)} THEN ${tierIndex(rule.tier)}`);
  for (const [origin, tier] of Object.entries(policy.originTiers)) {
    cases.push(`WHEN ${columns.origin} = ? THEN ${tierIndex(tier)}`);
    params.push(origin);
  }
  const fallback = tierIndex(policy.defaultTier);
  return cases.length ? `(CASE ${cases.join(" ")} ELSE ${fallback} END)` : String(fallback);
}

/**
 * Effective tier: a manual label wins. Otherwise the most restrictive of the configured floor,
 * the automatic tier (LLM refines heuristics; a distilled label stands in for an LLM label it
 * skipped and is never below the heuristic), and any hard heuristic finding. Records no
 * classifier has judged yet (for their current content) count as secret.
 */
function effectiveTierSql(kind: string, idSql: string, hashSql: string, floorSql: string) {
  const label = (origin: string, extra = "") =>
    `(SELECT tier FROM main.graph_access_labels WHERE kind='${kind}' AND record_id=${idSql} AND origin='${origin}'${extra})`;
  const current = ` AND content_hash=${hashSql}`;
  return `COALESCE(${label("manual")}, MAX(${floorSql}, COALESCE(${label("llm", current)}, ${label("distilled", current)}, ${label("heuristic", current)}, ${SECRET}),
    COALESCE(${label("heuristic", `${current} AND hard=1`)}, 0)))`;
}

function sourceFilterSql(profile: ResolvedProfile, policy: AccessPolicy, columns: SourceColumns & { id: string; hash: string }, params: SQLQueryBindings[]) {
  const floor = configTierSql(policy, columns, params);
  return sourceConditionsSql(profile, columns, effectiveTierSql("source", columns.id, columns.hash, floor), params);
}

function sourceConditionsSql(profile: ResolvedProfile, columns: SourceColumns, tier: string, params: SQLQueryBindings[]) {
  const conditions = [`${tier} <= ${tierIndex(profile.clearance)}`];
  if (profile.allow?.length) conditions.push(`(${profile.allow.map(m => matchSql(m, columns, params)).join(" OR ")})`);
  if (profile.deny?.length) conditions.push(`NOT (${profile.deny.map(m => matchSql(m, columns, params)).join(" OR ")})`);
  return conditions.join(" AND ");
}

/**
 * Compute every id the profile may see, set-based, in one read transaction.
 * Sources decide by tier and allow/deny rules; their chunks, revisions, passages, and evidence follow.
 * Entities and claims also need their own tier to pass and must be grounded in a visible source
 * (or have no source provenance at all). Claims depending on hidden claims are hidden too.
 */
export function materializeVisibility(db: Database, profile: ResolvedProfile, policy: AccessPolicy, prefix: string) {
  const t = (set: VisibleSet) => visibleTable(prefix, set);
  const clearance = tierIndex(profile.clearance);
  db.transaction(() => {
    for (const [set, columns] of Object.entries(VISIBLE_SETS)) {
      db.run(`CREATE TEMP TABLE IF NOT EXISTS ${prefix}_${set}(${columns}) STRICT`);
      db.run(`DELETE FROM ${t(set as VisibleSet)}`);
    }
    const params: SQLQueryBindings[] = [];
    const live = sourceFilterSql(profile, policy, { id: "s.id", hash: LIVE_SOURCE_CONTENT_HASH_SQL, origin: "s.origin", type: "s.type", uri: "s.uri" }, params);
    db.query(`INSERT INTO ${t("sources")} SELECT s.id FROM main.sources s WHERE ${live}`).run(...params);
    const archived: SQLQueryBindings[] = [];
    const snapshot = (field: string) => `coalesce(json_extract(a.snapshot,'$.source.${field}'),'')`;
    const archiveHash = sourceContentHashSql({ hash: snapshot("hash"), title: snapshot("title"), uri: snapshot("uri"),
      origin: snapshot("origin"), type: snapshot("type") });
    const archive = sourceFilterSql(profile, policy, { id: "a.source_id", hash: archiveHash, origin: snapshot("origin"),
      type: snapshot("type"), uri: snapshot("uri") }, archived);
    db.query(`INSERT INTO ${t("archives")} SELECT a.source_id FROM main.graph_source_archives a
      WHERE a.source_id NOT IN (SELECT id FROM main.sources) AND ${archive}`).run(...archived);
    const revisionParams: SQLQueryBindings[] = [];
    const revisionColumns = { uri: "r.uri", origin: "coalesce(s.origin,json_extract(a.snapshot,'$.source.origin'),'')",
      type: "coalesce(s.type,json_extract(a.snapshot,'$.source.type'),'')" };
    const revisionFloor = configTierSql(policy, revisionColumns, revisionParams);
    const revisionHash = sourceContentHashSql({ ...revisionColumns, hash: "r.hash", title: "r.title" });
    const sourceLabel = (origin: string, extra = "") => `(SELECT tier FROM main.graph_access_labels
      WHERE kind='source' AND record_id=r.source_id AND origin='${origin}'${extra})`;
    const judged = `l.content_hash=(${REVISION_CONTENT_HASH_SQL})`;
    const revisionTier = `COALESCE(${sourceLabel("manual")},MAX(${revisionFloor},
      CASE WHEN ${judged} THEN COALESCE(${sourceLabel("llm", ` AND content_hash=${revisionHash}`)},
        ${sourceLabel("distilled", ` AND content_hash=${revisionHash}`)},l.tier) ELSE ${SECRET} END,
      CASE WHEN ${judged} AND l.hard=1 THEN l.tier ELSE 0 END,
      COALESCE(${sourceLabel("heuristic", ` AND content_hash=${revisionHash} AND hard=1`)},0)))`;
    const revisionFilter = sourceConditionsSql(profile, revisionColumns, revisionTier, revisionParams);
    db.query(`INSERT INTO ${t("revisions")} SELECT r.id FROM main.graph_source_revisions r
      LEFT JOIN main.sources s ON s.id=r.source_id LEFT JOIN main.graph_source_archives a ON a.source_id=r.source_id
      LEFT JOIN main.graph_access_revision_labels l ON l.revision_id=r.id
      WHERE r.source_id IN (SELECT id FROM ${t("sources")} UNION ALL SELECT id FROM ${t("archives")})
      AND ${revisionFilter}`).run(...revisionParams);
    // Do not serve a source whose active memory has not passed the revision check yet.
    db.run(`DELETE FROM ${t("sources")} WHERE NOT EXISTS(SELECT 1 FROM main.sources s
      JOIN main.graph_source_revisions r ON r.source_id=s.id AND r.hash=s.hash
      WHERE s.id=${t("sources")}.id AND r.id IN (SELECT id FROM ${t("revisions")}))`);
    db.run(`DELETE FROM ${t("archives")} WHERE NOT EXISTS(SELECT 1 FROM main.graph_source_archives a
      JOIN main.graph_source_revisions r ON r.source_id=a.source_id AND r.hash=json_extract(a.snapshot,'$.source.hash')
      WHERE a.source_id=${t("archives")}.id AND r.id IN (SELECT id FROM ${t("revisions")}))`);
    db.run(`DELETE FROM ${t("revisions")} WHERE id IN (SELECT r.id FROM main.graph_source_revisions r
      WHERE r.source_id NOT IN (SELECT id FROM ${t("sources")} UNION ALL SELECT id FROM ${t("archives")}))`);
    db.run(`INSERT INTO ${t("chunks")} SELECT c.id FROM main.chunks c WHERE c.source_id IN (SELECT id FROM ${t("sources")})`);
    db.run(`INSERT OR IGNORE INTO ${t("texts")} SELECT p.text_id FROM main.graph_revision_passages p
      WHERE p.revision_id IN (SELECT id FROM ${t("revisions")})`);

    const entityTier = effectiveTierSql("entity", "CAST(e.id AS TEXT)", "coalesce(e.display_name,e.name)||char(31)||e.type", "0");
    const grounded = (visibleOnly: boolean) => {
      const sources = visibleOnly ? ` AND se.source_id IN (SELECT id FROM ${t("sources")})` : "";
      const chunks = visibleOnly ? ` AND ce.chunk_id IN (SELECT id FROM ${t("chunks")})` : "";
      const revisions = visibleOnly ? ` AND ev.revision_id IN (SELECT id FROM ${t("revisions")})` : "";
      return `(EXISTS(SELECT 1 FROM main.source_entities se WHERE se.entity_id=e.id${sources})
        OR EXISTS(SELECT 1 FROM main.chunk_entities ce WHERE ce.entity_id=e.id${chunks})
        OR EXISTS(SELECT 1 FROM main.graph_claims c JOIN main.graph_evidence ev ON ev.claim_id=c.id
          WHERE c.subject_id=e.id${revisions})
        OR EXISTS(SELECT 1 FROM main.graph_claims c JOIN main.graph_evidence ev ON ev.claim_id=c.id
          WHERE c.object_id=e.id${revisions}))`;
    };
    // An episode's title and summary are written from all of its members: every member must be visible.
    db.run(`WITH RECURSIVE episode_group(episode_id,member_id) AS MATERIALIZED (
        SELECT id,id FROM main.entities WHERE type='Episode'
        UNION SELECT g.episode_id,e.id FROM main.entities e JOIN episode_group g ON e.canonical_id=g.member_id),
      blocked_episodes AS MATERIALIZED (
        -- Source removal clears source_entities; durable claims still ground the narrative.
        SELECT DISTINCT g.episode_id FROM episode_group g JOIN main.graph_claims c ON c.object_id=g.member_id
        WHERE c.predicate='PART_OF_EPISODE' AND c.status IN ('accepted','proposed')
          AND json_extract(c.qualifiers,'$.sourceId') NOT IN (SELECT id FROM ${t("sources")})
        UNION SELECT g.episode_id FROM episode_group g JOIN main.graph_episode_provenance p ON p.entity_id=g.member_id
          WHERE p.source_id NOT IN (SELECT id FROM ${t("sources")}))
      INSERT INTO ${t("entities")} SELECT e.id FROM main.entities e
      WHERE ${entityTier} <= ${clearance} AND (${grounded(true)} OR NOT ${grounded(false)})
        AND (e.type!='Episode' OR (
          NOT EXISTS(SELECT 1 FROM main.source_entities se JOIN episode_group g ON g.member_id=se.entity_id WHERE g.episode_id=e.id
            AND se.source_id NOT IN (SELECT id FROM ${t("sources")}))
          AND e.id NOT IN (SELECT episode_id FROM blocked_episodes)))`);

    const claimTier = effectiveTierSql("claim", "c.id", "''", "0");
    db.run(`INSERT INTO ${t("claims")} SELECT c.id FROM main.graph_claims c
      WHERE ${claimTier} <= ${clearance}
        AND c.subject_id IN (SELECT id FROM ${t("entities")})
        AND (c.object_id IS NULL OR c.object_id IN (SELECT id FROM ${t("entities")}))
        AND (EXISTS(SELECT 1 FROM main.graph_evidence ev WHERE ev.claim_id=c.id AND ev.revision_id IN (SELECT id FROM ${t("revisions")}))
          OR NOT EXISTS(SELECT 1 FROM main.graph_evidence ev WHERE ev.claim_id=c.id))`);
    // Inferences over hidden claims would reveal them; drop dependents until stable.
    const prune = db.query(`DELETE FROM ${t("claims")} WHERE id IN (SELECT d.claim_id FROM main.graph_dependencies d
      WHERE d.depends_on NOT IN (SELECT id FROM ${t("claims")}))`);
    while (prune.run().changes > 0);
    db.run(`INSERT INTO ${t("evidence")} SELECT ev.id FROM main.graph_evidence ev
      WHERE ev.revision_id IN (SELECT id FROM ${t("revisions")}) AND ev.claim_id IN (SELECT id FROM ${t("claims")})`);
  })();
}

export function visibilityCounts(db: Database, prefix: string) {
  const count = (set: VisibleSet) => db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${visibleTable(prefix, set)}`).get()!.n;
  return { sources: count("sources"), entities: count("entities"), claims: count("claims"), chunks: count("chunks"), evidence: count("evidence") };
}

/** A record's effective tier under the current policy, for display alongside its labels. */
export function recordTier(db: Database, policy: AccessPolicy, kind: "source" | "entity" | "claim", id: string): number | undefined {
  const params: SQLQueryBindings[] = [];
  let sql: string;
  if (kind === "source") {
    const floor = configTierSql(policy, { origin: "s.origin", type: "s.type", uri: "s.uri" }, params);
    sql = `SELECT ${effectiveTierSql("source", "s.id", LIVE_SOURCE_CONTENT_HASH_SQL, floor)} AS tier FROM main.sources s WHERE s.id=?`;
  } else if (kind === "entity") {
    sql = `SELECT ${effectiveTierSql("entity", "CAST(e.id AS TEXT)", "coalesce(e.display_name,e.name)||char(31)||e.type", "0")} AS tier FROM main.entities e WHERE e.id=?`;
  } else {
    sql = `SELECT ${effectiveTierSql("claim", "c.id", "''", "0")} AS tier FROM main.graph_claims c WHERE c.id=?`;
  }
  return db.query<{ tier: number }, SQLQueryBindings[]>(sql).get(...params, kind === "entity" ? Number(id) : id)?.tier;
}
