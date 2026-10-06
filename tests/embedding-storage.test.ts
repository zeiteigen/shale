import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIndexDimension, vectorBuffer } from "../lib/embedding-index";
import { embeddingStorageDimensions, ensureVectorIndex } from "../lib/embedding-storage";

describe("Embedding storage configuration", () => {
  let db: Database;
  let originalDimension: string | undefined;
  beforeEach(() => {
    originalDimension = process.env.EMBEDDING_DIMENSIONS;
    db = new Database(":memory:");
    sqliteVec.load(db);
  });
  afterEach(() => {
    if (originalDimension === undefined) delete process.env.EMBEDDING_DIMENSIONS;
    else process.env.EMBEDDING_DIMENSIONS = originalDimension;
    db.close();
  });

  it("creates an index at the configured size and resizes an empty index", () => {
    process.env.EMBEDDING_DIMENSIONS = "2650";
    ensureVectorIndex(db);
    expect(getIndexDimension(db)).toBe(2650);
    process.env.EMBEDDING_DIMENSIONS = "2560";
    ensureVectorIndex(db);
    expect(getIndexDimension(db)).toBe(2560);
    db.query("INSERT INTO vector_index(rowid, embedding) VALUES (1, ?)")
      .run(vectorBuffer(new Array(2560).fill(0.01), 2560));
  });

  it("retains populated indexes until explicit reindexing", () => {
    process.env.EMBEDDING_DIMENSIONS = "4";
    ensureVectorIndex(db);
    db.query("INSERT INTO vector_index(rowid, embedding) VALUES (1, ?)")
      .run(vectorBuffer([1, 2, 3, 4], 4));
    const before = db.query("SELECT rowid, embedding FROM vector_index").all();
    process.env.EMBEDDING_DIMENSIONS = "2";
    ensureVectorIndex(db);
    expect(getIndexDimension(db)).toBe(4);
    expect(db.query("SELECT rowid, embedding FROM vector_index").all()).toEqual(before);
  });

  it("uses the default size and rejects invalid configuration before creating a table", () => {
    delete process.env.EMBEDDING_DIMENSIONS;
    expect(embeddingStorageDimensions()).toBe(4096);
    for (const value of ["0", "-1", "2.5", "invalid", "Infinity"]) {
      process.env.EMBEDDING_DIMENSIONS = value;
      expect(() => ensureVectorIndex(db)).toThrow("positive integer");
      expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'vector_index'").get()).toBeNull();
    }
  });

  it("reports the received dimensions and how to migrate a mismatched index", () => {
    expect(() => vectorBuffer([1, 2], 4)).toThrow("expected 4 finite dimensions, received 2");
    expect(() => vectorBuffer([1, 2], 4)).toThrow("reindex-embeddings.ts");
  });

  it("runs the reindex CLI against an existing database without creating missing databases", () => {
    const directory = mkdtempSync(join(tmpdir(), "shale-reindex-"));
    const path = join(directory, "existing.db");
    try {
      const fixture = new Database(path);
      sqliteVec.load(fixture);
      fixture.run("CREATE TABLE chunks (id INTEGER PRIMARY KEY, source_id TEXT, text_content TEXT)");
      fixture.run("CREATE VIRTUAL TABLE vector_index USING vec0(embedding float[4])");
      fixture.close();
      const cli = join(import.meta.dir, "../scripts/reindex-embeddings.ts");
      const result = Bun.spawnSync([process.execPath, cli, path], {
        env: { ...process.env, EMBEDDING_DIMENSIONS: "2560" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("Reindexed 0 chunks");
      const migrated = new Database(path, { readonly: true });
      expect(getIndexDimension(migrated)).toBe(2560);
      migrated.close();
      const missing = join(directory, "missing.db");
      expect(Bun.spawnSync([process.execPath, cli, missing]).exitCode).not.toBe(0);
      expect(existsSync(missing)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
