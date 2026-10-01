import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { resolve } from "node:path";
import { reindexEmbeddings } from "../lib/reindex-embeddings";

if (import.meta.main) {
  const path = resolve(process.argv[2] ?? "production.db");
  const database = new Database(path, { create: false });
  sqliteVec.load(database);
  database.run("PRAGMA foreign_keys = ON");
  try {
    console.log(
      `Reindexed ${await reindexEmbeddings(database)} chunks in ${path}`,
    );
  } finally {
    database.close();
  }
}
