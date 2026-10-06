import type { Database } from "bun:sqlite";
import { getIndexDimension } from "./embedding-index";
import { getRootSetting } from "./settings";

export function embeddingStorageDimensions(fallback = 4096): number {
  const configured = getRootSetting("EMBEDDING_DIMENSIONS");
  const dimension = configured === undefined || configured === "" ? fallback : Number(configured);
  if (!Number.isInteger(dimension) || dimension <= 0)
    throw new Error("Embedding storage dimensions must be a positive integer");
  return dimension;
}

/** Existing vectors must be regenerated explicitly; only an empty index can resize on startup. */
export function ensureVectorIndex(database: Database): void {
  const dimension = embeddingStorageDimensions();
  const existing = database.query(
    "SELECT 1 FROM sqlite_master WHERE name = 'vector_index'",
  ).get();
  database.transaction(() => {
    if (existing && getIndexDimension(database) !== dimension) {
      const count = database.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM vector_index",
      ).get()!.count;
      if (count) return;
      database.run("DROP TABLE vector_index");
      if (database.query("SELECT 1 FROM sqlite_master WHERE name = 'embedding_profile'").get())
        database.run("DELETE FROM embedding_profile");
    }
    database.run(`CREATE VIRTUAL TABLE IF NOT EXISTS vector_index USING vec0(
      embedding float[${dimension}] distance_metric=cosine
    )`);
  })();
}
