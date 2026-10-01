import type { Database } from "bun:sqlite";
import { getIndexDimension } from "./embedding-index";

/** Change only the distance metric; preserve row IDs, vector bytes, and provenance. */
export function ensureCosineIndex(database: Database): void {
  const schema = database.query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_master WHERE name = 'vector_index'",
  ).get()?.sql;
  if (!schema || /distance_metric\s*=\s*cosine/i.test(schema)) return;
  const dimension = getIndexDimension(database);
  database.transaction(() => {
    database.run("CREATE TEMP TABLE cosine_vectors AS SELECT rowid AS id, embedding FROM vector_index");
    database.run("DROP TABLE vector_index");
    database.run(`CREATE VIRTUAL TABLE vector_index USING vec0(embedding float[${dimension}] distance_metric=cosine)`);
    database.run("INSERT INTO vector_index(rowid, embedding) SELECT id, embedding FROM cosine_vectors");
    database.run("DROP TABLE cosine_vectors");
  })();
}
