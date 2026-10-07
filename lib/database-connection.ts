import type { Database } from "bun:sqlite";

/** Allow short writes from other local workers to finish before failing. */
export function configureDatabaseConnection(database: Database) {
  database.run("PRAGMA busy_timeout = 5000;");
  database.run("PRAGMA journal_mode = WAL;");
  database.run("PRAGMA foreign_keys = ON;");
}
