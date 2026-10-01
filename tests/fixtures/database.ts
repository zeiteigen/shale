import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import schema from "../../lib/db-init";

/** Exercise the real schema/triggers with a small, isolated vector index. */
export function createTestDatabase(dimensions = 4, cosine = true): Database {
  const database = new Database(":memory:");
  sqliteVec.load(database);
  database.run("PRAGMA foreign_keys = ON");
  const tables = schema.query<{ sql: string }, []>(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN
    ('sources', 'chunks', 'entities', 'edges', 'chunk_entities', 'extension_state', 'checkpoints', 'chunks_fts')
    ORDER BY name = 'chunks_fts'
  `).all();
  for (const { sql } of tables) database.run(sql);
  database.run(`CREATE VIRTUAL TABLE vector_index USING vec0(embedding float[${dimensions}]${cosine ? " distance_metric=cosine" : ""})`);
  for (const { sql } of schema.query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger'",
  ).all()) database.run(sql);
  return database;
}
