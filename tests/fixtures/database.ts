import { Database } from "bun:sqlite";
import schema from "../../lib/db-init";

/** Exercise the real schema and triggers in an isolated in-memory database. */
export function createTestDatabase(): Database {
  const database = new Database(":memory:");
  database.run("PRAGMA foreign_keys = ON");
  const tables = schema.query<{ sql: string }, []>(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN
    ('sources', 'chunks', 'entities', 'edges', 'chunk_entities', 'extension_state', 'checkpoints', 'chunks_fts')
    OR (type='table' AND name GLOB 'graph_*')
    ORDER BY name = 'chunks_fts'
  `).all();
  for (const { sql } of tables) database.run(sql);
  for (const { sql } of schema.query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger'",
  ).all()) database.run(sql);
  return database;
}
