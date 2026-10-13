import { Database } from "bun:sqlite";
import { configureDatabaseConnection } from "../database-connection";
import { classifyPending } from "./classify";
import { readAccessPolicy, resolveProfile, type ResolvedProfile } from "./policy";
import { materializeVisibility, visibilityCounts, visibleTable, type VisibleSet } from "./visibility";

const PREFIX = "access";

/** Tables without user content, readable unfiltered. FTS5 MATCH cannot run through a view; every
 *  `chunks_fts` query joins `chunks`, and every `entity_registry_fts` query joins `entities` (or a table
 *  keyed by entity), whose shadow views drop hidden rows. */
export const PASSTHROUGH_TABLES = new Set(["graph_relations", "graph_migrations", "chunks_fts", "entity_registry_fts"]);

/** Virtual-table storage (e.g. `chunks_fts_data`) has reserved names that cannot be shadowed. */
export function virtualTableStorage(db: Database): Set<string> {
  const names = new Set<string>();
  const virtual = db.query<{ name: string }, []>("SELECT name FROM main.sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'").all();
  for (const { name } of virtual) for (const suffix of ["data", "idx", "docsize", "config", "content"]) names.add(`${name}_${suffix}`);
  return names;
}

/** Row filters for content tables. Every other table or view is shadowed by an empty view (deny by default). */
export function shadowFilters(profileName: string): Record<string, string> {
  const v = (set: VisibleSet) => `(SELECT id FROM ${visibleTable(PREFIX, set)})`;
  const asText = (set: VisibleSet) => `(SELECT CAST(id AS TEXT) FROM ${visibleTable(PREFIX, set)})`;
  const actor = `'profile:${profileName.replace(/'/g, "''")}/*'`;
  return {
    sources: `id IN ${v("sources")}`,
    chunks: `id IN ${v("chunks")}`,
    chunk_entities: `chunk_id IN ${v("chunks")} AND entity_id IN ${v("entities")}`,
    source_entities: `source_id IN ${v("sources")} AND entity_id IN ${v("entities")}`,
    source_memories: `source_id IN ${v("sources")}`,
    source_snippets: `source_id IN ${v("sources")}`,
    source_observations: `source_id IN ${v("sources")}`,
    source_revision_fingerprints: `revision_id IN ${v("revisions")}`,
    graph_source_metadata: `source_id IN ${v("sources")} OR source_id IN ${v("archives")}`,
    graph_source_archives: `source_id IN ${v("archives")} OR source_id IN ${v("sources")}`,
    graph_source_revisions: `id IN ${v("revisions")}`,
    graph_revision_passages: `revision_id IN ${v("revisions")}`,
    graph_memory_texts: `id IN ${v("texts")}`,
    entities: `id IN ${v("entities")}`,
    graph_entity_retirements: `entity_id IN ${v("entities")}`,
    edges: `source_entity_id IN ${v("entities")} AND target_entity_id IN ${v("entities")} AND EXISTS(SELECT 1 FROM main.graph_claims c
      WHERE c.subject_id=source_entity_id AND c.object_id=target_entity_id AND c.predicate=relation AND c.id IN ${v("claims")})`,
    graph_aliases: `entity_id IN ${v("entities")}`,
    graph_identity_changes: `entity_id IN ${v("entities")} AND canonical_id IN ${v("entities")}`,
    graph_events: `entity_id IN ${v("entities")} AND (claim_id IS NULL OR claim_id IN ${v("claims")})`,
    graph_participants: `event_id IN ${v("entities")} AND entity_id IN ${v("entities")} AND claim_id IN ${v("claims")}`,
    graph_claims: `id IN ${v("claims")}`,
    graph_source_digests: `source_id IN ${v("sources")}`,
    graph_digest_signals: `source_id IN ${v("sources")} AND entity_id IN ${v("entities")}`,
    // An episode is labelled as sensitive as its most sensitive member (lib/access/classify.ts).
    graph_episodes: `entity_id IN ${v("entities")}`,
    graph_episode_provenance: `entity_id IN ${v("entities")} AND source_id IN ${v("sources")}`,
    graph_dependencies: `claim_id IN ${v("claims")} AND depends_on IN ${v("claims")}`,
    graph_claim_links: `source_id IN ${v("claims")} AND target_id IN ${v("claims")}`,
    graph_reviews: `claim_id IN ${v("claims")}`,
    graph_status_history: `claim_id IN ${v("claims")}`,
    graph_evidence: `id IN ${v("evidence")}`,
    graph_evidence_history: `evidence_id IN ${v("evidence")}`,
    graph_record_versions: `kind IN ('database','relation')
      OR (kind='source' AND (record_id IN ${v("sources")} OR record_id IN ${v("archives")}))
      OR (kind='chunk' AND record_id IN ${asText("chunks")})
      OR (kind IN ('entity','event') AND record_id IN ${asText("entities")})
      OR (kind='claim' AND record_id IN ${v("claims")})
      OR (kind='evidence' AND record_id IN ${v("evidence")})`,
    // A profile sees only its own audit entries, without the before/after snapshots they embed.
    graph_changes: `actor GLOB ${actor}`,
  };
}

const REDACTED_COLUMNS: Record<string, Record<string, string>> = {
  graph_changes: { operations: "'{}'", result: "'{}'" },
};

/**
 * A read-only connection whose TEMP views shadow every main table with the rows one profile may see.
 * Unqualified SQL resolves `temp` before `main`, so any SDK reader built on it is filtered.
 */
export class ScopedDatabase {
  readonly db: Database;
  private sealed = false;
  private seenVersion = -1;
  private seenSignature = "";
  private classificationPending = false;

  constructor(readonly profileName: string, private writer: Database, path: string) {
    if (!path || path === ":memory:") throw new Error("Restricted access profiles require a file-backed database");
    this.db = new Database(path);
    configureDatabaseConnection(this.db);
  }

  /** Install the shadow views. Call after any SDK built on this connection has run its schema setup. */
  seal() {
    if (this.sealed) return;
    const filters = shadowFilters(this.profileName);
    const objects = this.db.query<{ name: string; type: string; sql: string | null }, []>(
      "SELECT name,type,sql FROM main.sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'").all();
    const storage = virtualTableStorage(this.db);
    // Classify and record the snapshot once; the subsequent SDK refresh can reuse it.
    this.refresh();
    this.db.transaction(() => {
      for (const object of objects) {
        if (PASSTHROUGH_TABLES.has(object.name) || storage.has(object.name)) continue;
        const filter = filters[object.name];
        const quoted = `"${object.name.replace(/"/g, '""')}"`;
        let select = "*";
        const redacted = REDACTED_COLUMNS[object.name];
        if (redacted) {
          const columns = this.db.query<{ name: string }, []>(`PRAGMA main.table_info(${quoted})`).all().map(c => c.name);
          select = columns.map(c => redacted[c] ? `${redacted[c]} AS "${c}"` : `"${c}"`).join(",");
        }
        if (object.name === "graph_revision_chunks") {
          // Views in main never see temp shadows, so the passage view is rebuilt over filtered rows.
          this.db.run(`CREATE TEMP VIEW graph_revision_chunks AS SELECT p.revision_id,p.chunk_index,p.chunk_type,t.text_content
            FROM main.graph_revision_passages p JOIN main.graph_memory_texts t ON t.id=p.text_id
            WHERE p.revision_id IN (SELECT id FROM ${visibleTable(PREFIX, "revisions")})`);
          continue;
        }
        this.db.run(`CREATE TEMP VIEW ${quoted} AS SELECT ${select} FROM main.${quoted} WHERE ${filter ?? "0"}`);
      }
    })();
    this.sealed = true;
    this.db.run("PRAGMA query_only = ON");
  }

  /** Re-derive visibility when data, labels, or the policy changed since the last call. */
  refresh(): ResolvedProfile {
    const policy = readAccessPolicy();
    const profile = resolveProfile(this.profileName, policy);
    const version = this.dataVersion();
    if (version !== this.seenVersion || this.classificationPending)
      this.classificationPending = classifyPending(this.writer, { budgetMs: 1_500 }).pending;
    const signature = JSON.stringify([profile, policy.defaultTier, policy.originTiers, policy.tierRules]);
    const latest = this.dataVersion();
    if (latest === this.seenVersion && signature === this.seenSignature) return profile;
    this.materialize(profile, policy);
    this.seenVersion = latest;
    this.seenSignature = signature;
    return profile;
  }

  counts() {
    return visibilityCounts(this.db, PREFIX);
  }

  isVisible(set: VisibleSet, id: string | number) {
    return Boolean(this.db.query(`SELECT 1 FROM ${visibleTable(PREFIX, set)} WHERE id=?`).get(id));
  }

  close() {
    this.db.close();
  }

  private dataVersion() {
    return this.db.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version;
  }

  private materialize(profile = resolveProfile(this.profileName), policy = readAccessPolicy()) {
    if (this.sealed) this.db.run("PRAGMA query_only = OFF");
    try {
      materializeVisibility(this.db, profile, policy, PREFIX);
    } finally {
      if (this.sealed) this.db.run("PRAGMA query_only = ON");
    }
  }
}
