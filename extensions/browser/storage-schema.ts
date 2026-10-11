import type { Database } from "bun:sqlite";

/** Browser-owned tables keep transport state separate from indexed documents. */
export function ensureBrowserSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS browser_jobs (
      id TEXT PRIMARY KEY, extension_id TEXT NOT NULL, collector_id TEXT NOT NULL,
      record_id TEXT NOT NULL, batch_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
      payload TEXT NOT NULL,payload_bytes INTEGER NOT NULL DEFAULT 0, received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('received','prepared','indexed','skipped','failed')),
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
      prepared TEXT, settings TEXT, error TEXT, outcome TEXT,
      UNIQUE(extension_id,collector_id,record_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS browser_jobs_pending ON browser_jobs(extension_id,state,next_attempt_at,received_at);
    CREATE INDEX IF NOT EXISTS browser_jobs_batch ON browser_jobs(extension_id,collector_id,batch_id);
    CREATE TABLE IF NOT EXISTS browser_activity (
      extension_id TEXT NOT NULL, collector_id TEXT NOT NULL, event_id TEXT NOT NULL,
      occurred_at INTEGER NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(extension_id,collector_id,event_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS browser_activity_order ON browser_activity(extension_id,collector_id,occurred_at,sequence);
    CREATE TABLE IF NOT EXISTS browser_captures (
      extension_id TEXT NOT NULL,collector_id TEXT NOT NULL,record_id TEXT NOT NULL,event_id TEXT NOT NULL,
      content_key TEXT NOT NULL,captured_at INTEGER NOT NULL,source_id TEXT NOT NULL,
      PRIMARY KEY(extension_id,collector_id,record_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS browser_captures_event ON browser_captures(extension_id,collector_id,event_id,captured_at);
    CREATE TABLE IF NOT EXISTS browser_content_cache (
      extension_id TEXT NOT NULL, content_key TEXT NOT NULL, prepared TEXT NOT NULL,
      source_id TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(extension_id,content_key)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS browser_sessions (
      extension_id TEXT NOT NULL, session_id TEXT NOT NULL, collector_id TEXT NOT NULL,
      activity_hash TEXT NOT NULL, start_time INTEGER NOT NULL, end_time INTEGER NOT NULL,
      boundary_reason TEXT NOT NULL, prepared TEXT, settings TEXT, indexed_hash TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,error TEXT,prepared_at INTEGER,
      PRIMARY KEY(extension_id,session_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS browser_threads (
      extension_id TEXT NOT NULL, thread_id TEXT NOT NULL, label TEXT NOT NULL,
      goal TEXT, topics TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(extension_id,thread_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS browser_context_members (
      extension_id TEXT NOT NULL, collector_id TEXT NOT NULL, event_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, session_id TEXT NOT NULL,
      PRIMARY KEY(extension_id,collector_id,event_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS browser_context_overrides (
      extension_id TEXT NOT NULL, collector_id TEXT NOT NULL, event_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, label TEXT NOT NULL, goal TEXT,
      PRIMARY KEY(extension_id,collector_id,event_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS browser_catalog (
      extension_id TEXT NOT NULL, collector_id TEXT NOT NULL, kind TEXT NOT NULL,
      external_id TEXT NOT NULL, source_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      payload TEXT NOT NULL, PRIMARY KEY(extension_id,collector_id,kind,external_id)
    ) STRICT;
  `);
  const jobColumns = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(browser_jobs)")
      .all()
      .map((row) => row.name),
  );
  if (!jobColumns.has("payload_bytes")) {
    db.run(
      "ALTER TABLE browser_jobs ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0",
    );
    db.run(
      "UPDATE browser_jobs SET payload_bytes=length(CAST(payload AS BLOB))",
    );
  }
  db.run(
    "CREATE INDEX IF NOT EXISTS browser_jobs_capacity ON browser_jobs(extension_id,state,payload_bytes)",
  );
  const columns = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(browser_sessions)")
      .all()
      .map((row) => row.name),
  );
  for (const [name, type] of [
    ["attempts", "INTEGER NOT NULL DEFAULT 0"],
    ["next_attempt_at", "INTEGER NOT NULL DEFAULT 0"],
    ["error", "TEXT"],
    ["prepared_at", "INTEGER"],
  ])
    if (!columns.has(name!))
      db.run(`ALTER TABLE browser_sessions ADD COLUMN ${name} ${type}`);
}
