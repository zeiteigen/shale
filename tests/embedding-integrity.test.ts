import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { getEmbeddings } from "../lib/ai/embeddings";
import { vectorBuffer } from "../lib/embedding-index";
import { readEmbeddingProfile } from "../lib/embedding-profile";
import { reindexEmbeddings } from "../lib/reindex-embeddings";
import { UnifiedIngestor } from "../sdk/ingest";
import { ChunkSearcher } from "../sdk/search";
import { EmbedderClient } from "../sdk/embed";

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
});
