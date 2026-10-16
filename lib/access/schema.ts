import type { Database } from "bun:sqlite";
import { TIERS, type Tier } from "./policy";

export type LabelKind = "source" | "entity" | "claim";
/** `distilled`: a local model trained on LLM labels stood in for the LLM; never below the heuristic tier. */
export type LabelOrigin = "manual" | "heuristic" | "llm" | "distilled";
const ORIGINS_SQL = "'manual','heuristic','llm','distilled'";

export interface AccessLabel {
  kind: LabelKind;
  recordId: string;
  origin: LabelOrigin;
  tier: Tier;
  hard: boolean;
  reason: string;
  updatedAt: number;
}

/**
 * Sensitivity labels, one row per classifier. `hard` heuristic findings (credentials, card numbers)
 * cannot be lowered by the LLM; only a manual label overrides them. `content_hash` ties automatic
 * labels to the content they judged, so changed records are classified again.
 */
const labelTable = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (
    kind TEXT NOT NULL CHECK(kind IN ('source','entity','claim')), record_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN (${ORIGINS_SQL})),
    tier INTEGER NOT NULL CHECK(tier BETWEEN 0 AND ${TIERS.length - 1}), hard INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '', content_hash TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
    PRIMARY KEY(kind,record_id,origin)
  ) STRICT`;

export function ensureAccessSchema(db: Database) {
  db.run(labelTable("graph_access_labels"));
  // Older databases constrain origin to three values; SQLite cannot alter a CHECK, so rebuild the table once.
  const sql = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='graph_access_labels'").get()?.sql ?? "";
  if (!sql.includes("'distilled'")) db.transaction(() => {
    db.run("DROP TABLE IF EXISTS graph_access_labels_rebuild");
    db.run(labelTable("graph_access_labels_rebuild"));
    db.run(`INSERT INTO graph_access_labels_rebuild(kind,record_id,origin,tier,hard,reason,content_hash,updated_at)
      SELECT kind,record_id,origin,tier,hard,reason,content_hash,updated_at FROM graph_access_labels`);
    db.run("DROP TABLE graph_access_labels");
    db.run("ALTER TABLE graph_access_labels_rebuild RENAME TO graph_access_labels");
  })();
  db.run(`CREATE TABLE IF NOT EXISTS graph_access_revision_labels (
    revision_id INTEGER PRIMARY KEY REFERENCES graph_source_revisions(id) ON DELETE CASCADE,
    tier INTEGER NOT NULL CHECK(tier BETWEEN 0 AND ${TIERS.length - 1}), hard INTEGER NOT NULL,
    content_hash TEXT NOT NULL, updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS access_revision_passage_insert AFTER INSERT ON graph_revision_passages BEGIN
    DELETE FROM graph_access_revision_labels WHERE revision_id=NEW.revision_id;
  END;
  CREATE TRIGGER IF NOT EXISTS access_revision_passage_delete AFTER DELETE ON graph_revision_passages BEGIN
    DELETE FROM graph_access_revision_labels WHERE revision_id=OLD.revision_id;
  END;
  CREATE TRIGGER IF NOT EXISTS access_revision_passage_update AFTER UPDATE OF text_id,revision_id ON graph_revision_passages BEGIN
    DELETE FROM graph_access_revision_labels WHERE revision_id IN (OLD.revision_id,NEW.revision_id);
  END;
  CREATE TRIGGER IF NOT EXISTS access_revision_text_update AFTER UPDATE OF text_content ON graph_memory_texts BEGIN
    DELETE FROM graph_access_revision_labels WHERE revision_id IN (
      SELECT revision_id FROM graph_revision_passages WHERE text_id=NEW.id);
  END;`);
}

export function setLabel(db: Database, kind: LabelKind, recordId: string, origin: LabelOrigin, tier: number,
  options: { hard?: boolean; reason?: string; contentHash?: string } = {}) {
  db.query(`INSERT INTO graph_access_labels(kind,record_id,origin,tier,hard,reason,content_hash,updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(kind,record_id,origin) DO UPDATE SET tier=excluded.tier,hard=excluded.hard,reason=excluded.reason,
    content_hash=excluded.content_hash,updated_at=excluded.updated_at`)
    .run(kind, recordId, origin, tier, options.hard ? 1 : 0, options.reason ?? "", options.contentHash ?? "", Date.now());
}

export function clearLabel(db: Database, kind: LabelKind, recordId: string, origin: LabelOrigin = "manual") {
  db.query("DELETE FROM graph_access_labels WHERE kind=? AND record_id=? AND origin=?").run(kind, recordId, origin);
}

export function listLabels(db: Database, kind: LabelKind, recordId: string): AccessLabel[] {
  return db.query<{ kind: LabelKind; record_id: string; origin: LabelOrigin; tier: number; hard: number; reason: string; updated_at: number }, [string, string]>(
    "SELECT * FROM graph_access_labels WHERE kind=? AND record_id=? ORDER BY origin").all(kind, recordId)
    .map(row => ({ kind: row.kind, recordId: row.record_id, origin: row.origin, tier: TIERS[row.tier]!, hard: row.hard === 1,
      reason: row.reason, updatedAt: row.updated_at }));
}
