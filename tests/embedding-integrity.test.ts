import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { getEmbeddings } from "../lib/ai/embeddings";
import { getIndexDimension, vectorBuffer } from "../lib/embedding-index";
import { readEmbeddingProfile } from "../lib/embedding-profile";
import { reindexEmbeddings } from "../lib/reindex-embeddings";
import { UnifiedIngestor } from "../sdk/ingest";
import { ChunkSearcher } from "../sdk/search";
import { EmbedderClient } from "../sdk/embed";
import { createTestDatabase } from "./fixtures/database";

function database() {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  db.run(
    "CREATE TABLE sources (id TEXT PRIMARY KEY, type TEXT, uri TEXT, origin TEXT, created_at INTEGER, title TEXT, updated_at INTEGER, hash TEXT)",
  );
  db.run(
    "CREATE TABLE chunks (id INTEGER PRIMARY KEY, source_id TEXT, chunk_index INTEGER, chunk_type TEXT, text_content TEXT)",
  );
  db.run("CREATE VIRTUAL TABLE vector_index USING vec0(embedding float[4])");
  db.run(
    "CREATE TABLE entities (id INTEGER PRIMARY KEY, namespace TEXT, name TEXT, type TEXT, UNIQUE(namespace, name))",
  );
  db.run(
    "CREATE TABLE chunk_entities (chunk_id INTEGER, entity_id INTEGER, UNIQUE(chunk_id, entity_id))",
  );
  return db;
}
function options(model = "test-model") {
  return {
    endpoint: "https://test.invalid/v1/embeddings",
    model,
    padToDimensions: 4,
    fetchFn: async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      return Response.json({
        data: body.input.map((_: string, index: number) => ({
          index,
          embedding: [1, 2],
        })),
      });
    },
  };
}
function source(uri: string, vectors: number[][]) {
  return {
    source: { type: "test", uri, origin: "test", title: uri },
    chunks: vectors.map((embedding, i) => ({
      text_content: `chunk ${i}`,
      embedding,
    })),
  };
}

describe("Embedding integrity", () => {
  it("rejects malformed batches, invalid floats, and truncation before returning vectors", async () => {
    for (const data of [
      [],
      [{ index: 1, embedding: [1, 2] }],
      [{ index: 0, embedding: [1, null] }],
      [{ index: 0, embedding: [1, 2, 3, 4, 5] }],
    ]) {
      await expect(
        getEmbeddings(["one"], {
          ...options(),
          fetchFn: async () => Response.json({ data }),
        }),
      ).rejects.toThrow();
    }
    await expect(
      getEmbeddings(["one", "two"], {
        ...options(),
        fetchFn: async () =>
          Response.json({
            data: [
              { index: 0, embedding: [1, 2] },
              { index: 0, embedding: [2, 3] },
            ],
          }),
      }),
    ).rejects.toThrow("indices");
    await expect(
      getEmbeddings(["one", "two"], {
        ...options(),
        fetchFn: async () =>
          Response.json({
            data: [
              { index: 0, embedding: [1, 2] },
              { index: 1, embedding: [2] },
            ],
          }),
      }),
    ).rejects.toThrow("dimensions");
  });

  it("records provenance and rolls back replacement when a different model is used", async () => {
    const db = database();
    const ingest = new UnifiedIngestor("test", db);
    ingest.sourceAndChunks(
      source("original", await getEmbeddings(["one"], options())),
    );
    expect(readEmbeddingProfile(db)?.model).toBe("test-model");
    expect(() =>
      ingest.sourceAndChunks(source("original", [[1, 2, 0, 0]])),
    ).toThrow("embedding_profile");
    const incompatible = await getEmbeddings(["two"], options("other-model"));
    expect(() =>
      ingest.sourceAndChunks(source("original", incompatible)),
    ).toThrow("Reindex");
    expect(
      db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM chunks")
        .get()!.count,
    ).toBe(1);
    db.close();
  });

  it("refuses to guess the model of an existing untracked index", async () => {
    const db = database();
    const ingest = new UnifiedIngestor("test", db);
    ingest.sourceAndChunks(source("legacy", [[1, 2, 0, 0]]));
    const known = await getEmbeddings(["new"], options());
    expect(() => ingest.sourceAndChunks(source("new", known))).toThrow(
      "unknown embedding provenance",
    );
    db.close();
  });

  it("checks query provenance and requires metadata for precomputed search vectors", async () => {
    const db = database();
    const vectors = await getEmbeddings(["indexed"], options());
    new UnifiedIngestor("test", db).sourceAndChunks(source("known", vectors));
    const search = new ChunkSearcher(
      db,
      new EmbedderClient(options("other-model")),
    );
    await expect(search.vector({ query: "new query" })).rejects.toThrow(
      "Reindex",
    );
    await expect(search.vector({ vector: [1, 2, 0, 0] })).rejects.toThrow(
      "embeddingProfile",
    );
    expect((await search.vector({ vector: vectors[0] })).length).toBe(1);
    db.close();
  });

  it("serializes only the requested Float32Array view", () => {
    const floats = new Float32Array([99, 1, 2, 0, 0, 99]);
    expect(
      Array.from(
        new Float32Array(vectorBuffer(floats.subarray(1, 5), 4).buffer),
      ),
    ).toEqual([1, 2, 0, 0]);
  });

  it("reindexes old chunks atomically and retains the original vectors when requests fail", async () => {
    const db = database();
    const ingest = new UnifiedIngestor("test", db);
    ingest.sourceAndChunks(
      source("legacy", [
        [3, 4, 0, 0],
        [4, 3, 0, 0],
      ]),
    );
    const before = db
      .query("SELECT rowid, embedding FROM vector_index ORDER BY rowid")
      .all();
    let calls = 0;
    await expect(
      reindexEmbeddings(
        db,
        {
          ...options(),
          padToDimensions: 2,
          fetchFn: async (url: any, init: any) => {
            if (++calls === 2) throw new Error("offline");
            return options().fetchFn(url, init);
          },
        },
        1,
      ),
    ).rejects.toThrow("connect");
    expect(
      db
        .query("SELECT rowid, embedding FROM vector_index ORDER BY rowid")
        .all(),
    ).toEqual(before);
    expect(getIndexDimension(db)).toBe(4);
    expect(readEmbeddingProfile(db)).toBeNull();
    expect(await reindexEmbeddings(db, options(), 1)).toBe(2);
    expect(readEmbeddingProfile(db)?.model).toBe("test-model");
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM vector_index",
        )
        .get()!.count,
    ).toBe(2);
    db.close();
  });

  it("retains the old index if chunks change during reindexing", async () => {
    const db = database();
    new UnifiedIngestor("test", db).sourceAndChunks(
      source("old", [[3, 4, 0, 0]]),
    );
    await expect(
      reindexEmbeddings(db, {
        ...options(),
        fetchFn: async (url: any, init: any) => {
          db.run("UPDATE chunks SET text_content = 'changed'");
          return options().fetchFn(url, init);
        },
      }),
    ).rejects.toThrow("Chunks changed");
    expect(readEmbeddingProfile(db)).toBeNull();
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM vector_index",
        )
        .get()!.count,
    ).toBe(1);
    db.close();
  });

  it("resizes a populated index atomically and preserves chunks and deletion triggers", async () => {
    const db = createTestDatabase();
    const ingest = new UnifiedIngestor("test", db);
    ingest.sourceAndChunks(source("known", await getEmbeddings(["one", "two"], options())));
    const before = db.query("SELECT * FROM chunks ORDER BY id").all();
    expect(await reindexEmbeddings(db, { ...options("new-model"), padToDimensions: 2 })).toBe(2);
    expect(getIndexDimension(db)).toBe(2);
    expect(readEmbeddingProfile(db)).toMatchObject({ model: "new-model", storageDimensions: 2 });
    expect(db.query("SELECT * FROM chunks ORDER BY id").all()).toEqual(before);
    const vectors = db.query<{ rowid: number; embedding: Uint8Array }, []>(
      "SELECT rowid, embedding FROM vector_index ORDER BY rowid",
    ).all();
    expect(vectors.map(v => v.embedding.byteLength)).toEqual([8, 8]);
    expect((await new ChunkSearcher(db, new EmbedderClient({ ...options("new-model"), padToDimensions: 2 }))
      .vector({ query: "one" })).length).toBe(2);
    db.query("DELETE FROM chunks WHERE id = ?").run(vectors[0].rowid);
    expect(db.query("SELECT rowid FROM vector_index").all()).toEqual([{ rowid: vectors[1].rowid }]);
    db.close();
  });

  it("rolls back schema, vectors, and provenance if a resized index cannot commit", async () => {
    const db = database();
    new UnifiedIngestor("test", db).sourceAndChunks(source("known", await getEmbeddings(["one"], options())));
    const before = db.query("SELECT rowid, embedding FROM vector_index").all();
    const profile = readEmbeddingProfile(db);
    db.run(`CREATE TRIGGER reject_profile BEFORE UPDATE ON embedding_profile BEGIN
      SELECT RAISE(ABORT, 'profile commit rejected');
    END`);
    await expect(reindexEmbeddings(db, { ...options("new-model"), padToDimensions: 6 }))
      .rejects.toThrow("profile commit rejected");
    expect(getIndexDimension(db)).toBe(4);
    expect(db.query("SELECT rowid, embedding FROM vector_index").all()).toEqual(before);
    expect(readEmbeddingProfile(db)).toEqual(profile);
    expect(db.query("SELECT 1 FROM sqlite_temp_master WHERE name = 'reindex_vectors'").get()).toBeNull();
    db.close();
  });

  it("uses EMBEDDING_DIMENSIONS for reindexing rather than the old index size", async () => {
    const original = process.env.EMBEDDING_DIMENSIONS;
    const db = database();
    try {
      new UnifiedIngestor("test", db).sourceAndChunks(source("old", [[1, 2, 3, 4]]));
      process.env.EMBEDDING_DIMENSIONS = "2560";
      const { padToDimensions, ...configured } = options();
      await reindexEmbeddings(db, configured);
      expect(getIndexDimension(db)).toBe(2560);
      expect(readEmbeddingProfile(db)?.storageDimensions).toBe(2560);
    } finally {
      if (original === undefined) delete process.env.EMBEDDING_DIMENSIONS;
      else process.env.EMBEDDING_DIMENSIONS = original;
      db.close();
    }
  });

  it("supports native dimensions and resizing an index with no chunks", async () => {
    const db = database();
    const ingest = new UnifiedIngestor("test", db);
    ingest.sourceAndChunks(source("old", [[1, 2, 3, 4]]));
    await reindexEmbeddings(db, { ...options(), padToDimensions: null });
    expect(getIndexDimension(db)).toBe(2);
    db.run("DELETE FROM chunks");
    expect(await reindexEmbeddings(db, { ...options(), padToDimensions: 6 })).toBe(0);
    expect(getIndexDimension(db)).toBe(6);
    expect(readEmbeddingProfile(db)).toBeNull();
    db.close();
  });
});
