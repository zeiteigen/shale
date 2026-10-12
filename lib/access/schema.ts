import type { Database } from "bun:sqlite";
import { TIERS, type Tier } from "./policy";

export type LabelKind = "source" | "entity" | "claim";
export type LabelOrigin = "manual" | "heuristic" | "llm";

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
export function ensureAccessSchema(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS graph_access_labels (
    kind TEXT NOT NULL CHECK(kind IN ('source','entity','claim')), record_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('manual','heuristic','llm')),
    tier INTEGER NOT NULL CHECK(tier BETWEEN 0 AND ${TIERS.length - 1}), hard INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '', content_hash TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
    PRIMARY KEY(kind,record_id,origin)
  ) STRICT`);
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
