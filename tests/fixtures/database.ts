import { Database } from "bun:sqlite";
import schema from "../../lib/db-init";

/** Exercise the real schema and triggers in an isolated database (in memory unless a file path is given). */
export function createTestDatabase(path = ":memory:"): Database {
  const database = new Database(path);
  if (path !== ":memory:") database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA foreign_keys = ON");
  const tables = schema.query<{ sql: string }, []>(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN
    ('sources', 'chunks', 'entities', 'edges', 'chunk_entities', 'extension_state', 'checkpoints', 'chunks_fts')
    OR (type='table' AND (name GLOB 'graph_*' OR name GLOB 'source_*'))
    ORDER BY name = 'chunks_fts'
  `).all();
  for (const { sql } of tables) database.run(sql);
  for (const { sql } of schema.query<{sql:string},[]>("SELECT sql FROM sqlite_master WHERE type='view'").all()) database.run(sql);
  for (const { sql } of schema.query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger'",
  ).all()) database.run(sql);
  return database;
}
