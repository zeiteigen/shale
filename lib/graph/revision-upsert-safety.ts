import type { Database } from "bun:sqlite";
/** Explicit UPSERT clauses keep outer source UPSERTs from overriding trigger conflict handling. */
export function ensureRevisionUpsertSafety(db: Database) {
  const triggers = db
    .query<{ name: string; sql: string }, []>(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('graph_source_snapshot','graph_source_update')",
    )
    .all()
    .filter((row) =>
      row.sql.includes("INSERT OR IGNORE INTO graph_source_revisions"),
    );
  if (!triggers.length) return;
  db.transaction(() => {
    for (const trigger of triggers) {
      const sql = trigger.sql
        .replace(
          "INSERT OR IGNORE INTO graph_source_revisions",
          "INSERT INTO graph_source_revisions",
        )
        .replace(
          "VALUES(NEW.id,NEW.hash,NEW.uri,NEW.title,NEW.updated_at);",
          "VALUES(NEW.id,NEW.hash,NEW.uri,NEW.title,NEW.updated_at) ON CONFLICT(source_id,hash) DO NOTHING;",
        );
      db.run(`DROP TRIGGER ${trigger.name}`);
      db.run(sql);
    }
  })();
}
