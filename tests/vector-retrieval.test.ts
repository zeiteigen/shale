import { expect, it } from "bun:test";
import { UnifiedIngestor, ChunkSearcher } from "../sdk";
import { createTestDatabase } from "./fixtures/database";

it("migrates legacy Euclidean indexes without changing vectors or cascade triggers", async () => {
  const database = createTestDatabase(4, false);
  const ingest = new UnifiedIngestor("test", database);
  const insert = (id: string, vector: number[]) => ingest.sourceAndChunks({
    source: { id, type: "test", origin: "test", uri: id, title: id },
    chunks: [{ text_content: id, embedding: vector }],
  });
  try {
    insert("direction", [10, 0, 0, 0]);
    insert("close", [1, 1, 0, 0]);
    const before = database.query("SELECT rowid, embedding FROM vector_index ORDER BY rowid").all();
    const results = await new ChunkSearcher(database).vector({ vector: [1, 0, 0, 0], limit: 1 });
    expect(results[0].source_id).toBe("direction");
    expect(results[0].score).toBeCloseTo(1);
    expect(database.query("SELECT rowid, embedding FROM vector_index ORDER BY rowid").all()).toEqual(before);
    database.run("DELETE FROM sources WHERE id = 'direction'");
    expect(database.query("SELECT rowid FROM vector_index").all()).toHaveLength(1);
  } finally {
    database.close();
  }
});

it("finds filtered neighbors outside the global top K for source and chunk type", async () => {
  const database = createTestDatabase();
  const ingest = new UnifiedIngestor("test", database);
  const query = [1, 0, 0, 0];
  try {
    for (let i = 0; i < 12; i++) ingest.sourceAndChunks({
      source: { type: "test", origin: "test", uri: `other:${i}`, title: "Other" },
      chunks: [{ text_content: "Unfiltered", embedding: query }],
    });
    const target = ingest.sourceAndChunks({
      source: { type: "test", origin: "test", uri: "target", title: "Target" },
      chunks: [
        { text_content: "Match", chunk_type: "synthetic", embedding: [1, 1, 0, 0] },
        { text_content: "Weak", chunk_type: "synthetic", embedding: [0, 1, 0, 0] },
      ],
    });
    const search = new ChunkSearcher(database);
    for (const filter of [{ filterSourceId: target.sourceId }, { filterSourceId: "target" }, { filterChunkType: "synthetic" as const }]) {
      const results = await search.vector({ vector: query, limit: 1, ...filter });
      expect(results[0].text_content).toBe("Match");
    }
    expect(await search.vector({ vector: query, filterChunkType: "synthetic", minSimilarity: 0.8 })).toEqual([]);
    const replaced = ingest.sourceAndChunks({
      source: { type: "test", origin: "test", uri: "target", title: "Renamed" },
      chunks: [{ text_content: "Updated", embedding: query }],
    });
    expect(replaced.sourceId).toBe(target.sourceId);
  } finally {
    database.close();
  }
});
