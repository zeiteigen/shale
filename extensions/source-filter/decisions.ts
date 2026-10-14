import type { Database } from 'bun:sqlite';
import type { FilterVerdict, StoredDecision } from './types';

interface Row {
  source_id: string; content_key: string; policy_key: string; source_version: number;
  verdict: string; attempts: number; retry_at: number; applied_at: number | null;
}

/** Private per-source work survives archival, a crash, and changes to scan ordering. */
export class FilterDecisions {
  constructor(private db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS source_filter_decisions (
      source_id TEXT PRIMARY KEY, content_key TEXT NOT NULL, policy_key TEXT NOT NULL,
      source_version INTEGER NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('keep','remove','review')),
      verdict TEXT NOT NULL CHECK(json_valid(verdict)), attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0, applied_at INTEGER, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS source_filter_pending ON source_filter_decisions(decision,retry_at);`);
  }

  get(sourceId: string): StoredDecision | null {
    const row = this.db.query<Row, [string]>('SELECT * FROM source_filter_decisions WHERE source_id=?').get(sourceId);
    return row ? { sourceId: row.source_id, contentKey: row.content_key, policyKey: row.policy_key,
      sourceVersion: row.source_version, verdict: JSON.parse(row.verdict) as FilterVerdict,
      attempts: row.attempts, retryAt: row.retry_at, appliedAt: row.applied_at } : null;
  }

  save(decision: StoredDecision) {
    this.db.query(`INSERT INTO source_filter_decisions
      (source_id,content_key,policy_key,source_version,decision,verdict,attempts,retry_at,applied_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET content_key=excluded.content_key,
      policy_key=excluded.policy_key,source_version=excluded.source_version,decision=excluded.decision,
      verdict=excluded.verdict,attempts=excluded.attempts,retry_at=excluded.retry_at,
      applied_at=excluded.applied_at,updated_at=excluded.updated_at`).run(decision.sourceId, decision.contentKey,
        decision.policyKey, decision.sourceVersion, decision.verdict.decision, JSON.stringify(decision.verdict),
        decision.attempts, decision.retryAt, decision.appliedAt, Date.now());
  }

  markApplied(sourceId: string, contentKey: string, policyKey: string) {
    this.db.query('UPDATE source_filter_decisions SET applied_at=?,updated_at=? WHERE source_id=? AND content_key=? AND policy_key=?')
      .run(Date.now(), Date.now(), sourceId, contentKey, policyKey);
  }

  /** Repair the receipt marker when a process died after the atomic archive committed. */
  reconcile() {
    this.db.run(`UPDATE source_filter_decisions SET applied_at=(SELECT removed_at FROM graph_source_archives a
      WHERE a.source_id=source_filter_decisions.source_id),updated_at=unixepoch()*1000
      WHERE decision='remove' AND applied_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM sources s WHERE s.id=source_filter_decisions.source_id)
        AND EXISTS(SELECT 1 FROM graph_source_archives a WHERE a.source_id=source_filter_decisions.source_id
          AND a.actor='extension:source-filter');`);
  }
}
