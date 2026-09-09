import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import {
  createExtensionSDK,
  runWithSDK,
  search,
  searchChunks,
  searchHybrid,
  searchVector,
  searchBM25,
  extractKeywords,
  ChunkSearcher,
  DEFAULT_STOP_WORDS,
  type ChunkSearchResult,
} from "../sdk";
import { EmbedderClient } from "../sdk/embed";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  sqliteVec.load(db);

  // Sources
  db.run(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      uri TEXT NOT NULL,
      origin TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      title TEXT NOT NULL,
      updated_at INT NOT NULL,
      hash TEXT NOT NULL
    ) STRICT;
  `);

  // Chunks
  db.run(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      source_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text_content TEXT NOT NULL,
      FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE CASCADE
    ) STRICT;
  `);

  // Vector virtual table (4-dimensional for unit testing)
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vector_index USING vec0(
      embedding float[4]
    );
  `);

  // FTS5 virtual table
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text_content, 
      content='chunks', 
      content_rowid='id', 
      tokenize='porter'
    );
  `);

  // Triggers
  db.run(`
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text_content) VALUES (new.id, new.text_content);
    END;
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text_content) VALUES ('delete', old.id, old.text_content);
    END;
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text_content) VALUES ('delete', old.id, old.text_content);
      INSERT INTO chunks_fts(rowid, text_content) VALUES (new.id, new.text_content);
    END;
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS chunks_vector_ad AFTER DELETE ON chunks BEGIN
      DELETE FROM vector_index WHERE rowid = old.id;
    END;
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS chunks_vector_au AFTER UPDATE ON chunks BEGIN
      DELETE FROM vector_index WHERE rowid = old.id AND old.id != new.id;
    END;
  `);

  // Extension state table
  db.run(`
    CREATE TABLE IF NOT EXISTS extension_state (
      extension_id TEXT NOT NULL,
      state_key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (extension_id, state_key)
    ) STRICT;
  `);

  return db;
}

/**
 * Inserts a chunk along with its vector embedding.
 */
function insertChunk(
  db: Database,
  id: number,
  sourceId: string,
  chunkIndex: number,
  textContent: string,
  embedding: number[],
) {
  db.query(
    "INSERT INTO chunks (id, source_id, chunk_index, text_content) VALUES (?, ?, ?, ?)",
  ).run(id, sourceId, chunkIndex, textContent);

  db.query("INSERT INTO vector_index (rowid, embedding) VALUES (?, ?)").run(
    id,
    new Uint8Array(new Float32Array(embedding).buffer),
  );
}

describe("Chunk Search Engine in Shale SDK", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();

    // Populate test sources
    db.run(`
      INSERT INTO sources (id, type, uri, origin, created_at, title, updated_at, hash)
      VALUES 
        ('src-tech', 'doc', 'file:///docs/tech.md', 'test', 1000, 'Technical Architecture', 1000, 'h1'),
        ('src-science', 'doc', 'file:///docs/science.md', 'test', 1000, 'Scientific Principles', 1000, 'h2');
    `);

    // Populate test chunks:
    // Chunk 1: Bun runtime focus (Vector: [1, 0, 0, 0])
    insertChunk(
      db,
      1,
      "src-tech",
      0,
      "Bun is a fast all-in-one JavaScript and TypeScript runtime built for modern web development.",
      [1.0, 0.0, 0.0, 0.0],
    );

    // Chunk 2: SQLite database focus (Vector: [0, 1, 0, 0])
    insertChunk(
      db,
      2,
      "src-tech",
      1,
      "SQLite is a C-language library that implements a small, fast, self-contained SQL database engine.",
      [0.0, 1.0, 0.0, 0.0],
    );

    // Chunk 3: Combined Bun and SQLite focus (Vector: [0.7071, 0.7071, 0, 0] - 45 deg between 1 and 2)
    insertChunk(
      db,
      3,
      "src-tech",
      2,
      "Shale combines Bun runtime and SQLite database to deliver high performance vector search.",
      [0.7071, 0.7071, 0.0, 0.0],
    );

    // Chunk 4: Quantum Computing focus (Vector: [0, 0, 1, 0])
    insertChunk(
      db,
      4,
      "src-science",
      0,
      "Quantum computing utilizes quantum superposition and entanglement to perform complex state calculations.",
      [0.0, 0.0, 1.0, 0.0],
    );

    // Chunk 5: Quantum Entanglement and Physics (Vector: [0, 0, 0.7071, 0.7071])
    insertChunk(
      db,
      5,
      "src-science",
      1,
      "Entanglement in quantum physics enables correlated states across atomic distances and quantum networks.",
      [0.0, 0.0, 0.7071, 0.7071],
    );
  });

  describe("Keyword Extraction & Stopword Removal", () => {
    it("breaks a sentence into keywords and discards stopwords like 'of', 'and', 'the'", () => {
      const sentence =
        "The architecture and performance of SQLite and Bun runtime in web systems";
      const keywords = extractKeywords(sentence);

      expect(keywords).toContain("architecture");
      expect(keywords).toContain("performance");
      expect(keywords).toContain("sqlite");
      expect(keywords).toContain("bun");
      expect(keywords).toContain("runtime");
      expect(keywords).toContain("web");
      expect(keywords).toContain("systems");

      // Verify stopwords are discarded
      expect(keywords).not.toContain("the");
      expect(keywords).not.toContain("and");
      expect(keywords).not.toContain("of");
      expect(keywords).not.toContain("in");
    });

    it("respects keepStopWords option", () => {
      const sentence = "The state of the art";
      const keywords = extractKeywords(sentence, { keepStopWords: true });

      expect(keywords).toContain("the");
      expect(keywords).toContain("state");
      expect(keywords).toContain("of");
      expect(keywords).toContain("art");
    });

    it("supports custom stop words", () => {
      const sentence = "React and Vue with Vite bundler";
      const keywords = extractKeywords(sentence, {
        stopWords: ["react", "vue", "and", "with"],
      });

      expect(keywords).toEqual(["vite", "bundler"]);
    });

    it("falls back to raw tokens if all words are stopwords", () => {
      const sentence = "To be or not to be";
      const keywords = extractKeywords(sentence);

      expect(keywords.length).toBeGreaterThan(0);
      expect(keywords).toContain("to");
      expect(keywords).toContain("be");
    });

    it("supports SQLite json_each builtin filtering when useSqliteStopwords is enabled", () => {
      const sentence = "History of physics and mathematics";
      const keywords = extractKeywords(sentence, {
        useSqliteStopwords: true,
        db,
      });

      expect(keywords).toContain("history");
      expect(keywords).toContain("physics");
      expect(keywords).toContain("mathematics");
      expect(keywords).not.toContain("of");
      expect(keywords).not.toContain("and");
    });
  });

  describe("Mode 2: Vector Embeddings Only Search", () => {
    it("searches by raw vector and provides accurate cosine similarity", async () => {
      const searcher = new ChunkSearcher(db);

      // Query vector [1, 0, 0, 0] exactly matches chunk 1
      const results = await searcher.vector({
        vector: [1.0, 0.0, 0.0, 0.0],
        limit: 3,
      });

      expect(results.length).toBe(3);
      // Chunk 1 should be rank 1 with cosine similarity 1.0
      expect(results[0].id).toBe(1);
      expect(results[0].cosineSimilarity).toBeCloseTo(1.0, 4);
      expect(results[0].distance).toBeCloseTo(0.0, 4);
      expect(results[0].rank).toBe(1);
      expect(results[0].source_title).toBe("Technical Architecture");

      // Chunk 3 is at 45 degrees: [0.7071, 0.7071, 0, 0], cosine similarity should be ~0.7071
      expect(results[1].id).toBe(3);
      expect(results[1].cosineSimilarity).toBeCloseTo(0.7071, 3);

      // Chunks 2, 4, and 5 are orthogonal: cosine similarity should be 0.0
      expect([2, 4, 5]).toContain(results[2].id);
      expect(results[2].cosineSimilarity).toBeCloseTo(0.0, 3);
    });

    it("searches by pre-existing chunk ID (KNN) and excludes self by default", async () => {
      const searcher = new ChunkSearcher(db);

      // K Nearest Neighbors for chunk 1 (Bun)
      const results = await searcher.vector({
        chunkId: 1,
        limit: 2,
        excludeSelf: true,
      });

      expect(results.length).toBe(2);
      // Chunk 1 itself should NOT be in the results
      expect(results.some((r) => r.id === 1)).toBe(false);

      // Nearest neighbor to chunk 1 is chunk 3 (which has both Bun and SQLite)
      expect(results[0].id).toBe(3);
      expect(results[0].cosineSimilarity).toBeCloseTo(0.7071, 3);
      expect(results[0].rank).toBe(1);
    });

    it("allows including self in KNN search when excludeSelf is false", async () => {
      const searcher = new ChunkSearcher(db);

      const results = await searcher.vector({
        chunkId: 1,
        limit: 2,
        excludeSelf: false,
      });

      expect(results.length).toBe(2);
      expect(results[0].id).toBe(1);
      expect(results[0].cosineSimilarity).toBeCloseTo(1.0, 4);
    });

    it("throws helpful error when chunk ID has no vector in vector_index", async () => {
      const searcher = new ChunkSearcher(db);

      await expect(searcher.vector({ chunkId: 99999 })).rejects.toThrow(
        /Chunk with id 99999 not found/,
      );
    });

    it("filters results by minSimilarity threshold", async () => {
      const searcher = new ChunkSearcher(db);

      // Query vector [1, 0, 0, 0] with minSimilarity 0.5
      const results = await searcher.vector({
        vector: [1.0, 0.0, 0.0, 0.0],
        minSimilarity: 0.5,
      });

      // Chunk 1 (1.0) and Chunk 3 (0.7071) pass; Chunk 2 (0.0) is filtered out
      expect(results.length).toBe(2);
      expect(results.map((r) => r.id)).toEqual([1, 3]);
    });

    it("filters results by filterSourceId", async () => {
      const searcher = new ChunkSearcher(db);

      const results = await searcher.vector({
        vector: [0.0, 0.0, 1.0, 0.0],
        filterSourceId: "src-science",
      });

      expect(results.length).toBe(2);
      expect(results.every((r) => r.source_id === "src-science")).toBe(true);
    });

    it("generates query embedding automatically using embedder when query string is given", async () => {
      const mockEmbedder = new EmbedderClient();
      // Mock embed to return vector for "quantum"
      mockEmbedder.embed = async () => [0.0, 0.0, 1.0, 0.0];

      const searcher = new ChunkSearcher(db, mockEmbedder);
      const results = await searcher.vector({
        query: "quantum computing principles",
        limit: 2,
      });

      expect(results.length).toBe(2);
      expect(results[0].id).toBe(4);
      expect(results[0].cosineSimilarity).toBeCloseTo(1.0, 4);
    });
  });

  describe("Mode 3: BM25 Only Search", () => {
    it("searches with a single keyword and returns BM25 score with snippet preview", async () => {
      const searcher = new ChunkSearcher(db);

      const results = await searcher.bm25({
        query: "SQLite",
        limit: 5,
      });

      expect(results.length).toBe(2);
      // Chunks 2 and 3 contain "SQLite"
      const ids = results.map((r) => r.id);
      expect(ids).toContain(2);
      expect(ids).toContain(3);
      expect(results[0].bm25Score).toBeDefined();
      expect(results[0].preview).toContain("<mark>");
      expect(results[0].preview?.toLowerCase()).toContain("sqlite");
    });

    it("breaks sentence down into keywords, discards stopwords, and fuses results across keywords", async () => {
      const searcher = new ChunkSearcher(db);

      // Sentence contains 'and', 'the', 'of' which will be discarded,
      // leaving keywords: ['bun', 'sqlite']
      const results = await searcher.bm25({
        query: "The integration of Bun and SQLite in runtime systems",
        limit: 5,
        keywordFusion: "rrf",
      });

      expect(results.length).toBeGreaterThanOrEqual(3);

      // Chunk 3 matches BOTH "bun" AND "sqlite", so its fused RRF score should rank it #1!
      expect(results[0].id).toBe(3);
      expect(results[0].matchedKeywords).toContain("bun");
      expect(results[0].matchedKeywords).toContain("sqlite");

      // Chunks 1 and 2 only match one keyword each, so their scores are lower than Chunk 3
      const chunk3Score = results[0].score;
      const otherScores = results.slice(1).map((r) => r.score);
      for (const s of otherScores) {
        expect(chunk3Score).toBeGreaterThan(s);
      }
    });

    it("supports sum_scores keyword fusion strategy", async () => {
      const searcher = new ChunkSearcher(db);

      const results = await searcher.bm25({
        query: "quantum entanglement and physics",
        keywordFusion: "sum_scores",
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].matchedKeywords).toBeDefined();
      expect(results[0].score).toBeGreaterThan(0);
    });

    it("supports disjunctive keyword fusion strategy", async () => {
      const searcher = new ChunkSearcher(db);

      const results = await searcher.bm25({
        query: "quantum physics",
        keywordFusion: "disjunctive",
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].bm25Score).toBeDefined();
    });

    it("respects filterSourceId", async () => {
      const searcher = new ChunkSearcher(db);

      const results = await searcher.bm25({
        query: "runtime and database",
        filterSourceId: "src-tech",
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.source_id === "src-tech")).toBe(true);
    });
  });

  describe("Mode 1: Hybrid Search", () => {
    it("fuses vector search and BM25 search using Reciprocal Rank Fusion (RRF)", async () => {
      const mockEmbedder = new EmbedderClient();
      // Mock embedding pointing to Chunk 3 [0.7071, 0.7071, 0.0, 0.0]
      mockEmbedder.embed = async () => [0.7071, 0.7071, 0.0, 0.0];

      const searcher = new ChunkSearcher(db, mockEmbedder);

      const results = await searcher.hybrid({
        query: "Bun runtime with SQLite database",
        limit: 3,
        fusion: {
          strategy: "rrf",
          rrfK: 60,
          vectorWeight: 1.0,
          bm25Weight: 1.0,
        },
      });

      expect(results.length).toBe(3);
      // Chunk 3 is rank 1 in both vector similarity and BM25 matches for Bun + SQLite
      expect(results[0].id).toBe(3);
      expect(results[0].fusionDetails?.strategy).toBe("rrf");
      expect(results[0].fusionDetails?.rrfScore).toBeDefined();
      expect(results[0].cosineSimilarity).toBeDefined();
      expect(results[0].bm25Score).toBeDefined();
      expect(results[0].rank).toBe(1);
    });

    it("respects vectorWeight and bm25Weight in RRF fusion", async () => {
      const searcher = new ChunkSearcher(db);

      // Heavy vector weight favoring quantum physics vector [0, 0, 1, 0]
      const resultsVectorHeavy = await searcher.hybrid({
        query: "Bun runtime",
        vector: [0.0, 0.0, 1.0, 0.0], // Points to Quantum chunk 4
        fusion: {
          strategy: "rrf",
          vectorWeight: 10.0,
          bm25Weight: 0.1,
        },
      });

      // Vector chunk 4 should rank first despite query text mentioning Bun
      expect(resultsVectorHeavy[0].id).toBe(4);

      // Heavy BM25 weight favoring Bun text
      const resultsBm25Heavy = await searcher.hybrid({
        query: "Bun runtime",
        vector: [0.0, 0.0, 1.0, 0.0],
        fusion: {
          strategy: "rrf",
          vectorWeight: 0.1,
          bm25Weight: 10.0,
        },
      });

      // BM25-matching chunks should rank first due to BM25 dominance
      expect([1, 3]).toContain(resultsBm25Heavy[0].id);
      expect(resultsBm25Heavy[0].text_content).toContain("Bun");
    });

    it("supports linear normalized score fusion", async () => {
      const searcher = new ChunkSearcher(db);

      const results = await searcher.hybrid({
        query: "SQLite database",
        vector: [0.0, 1.0, 0.0, 0.0], // Exact match to SQLite chunk 2
        fusion: {
          strategy: "linear",
          vectorWeight: 0.9,
          bm25Weight: 0.1,
        },
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].fusionDetails?.strategy).toBe("linear");
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].id).toBe(2);
    });

    it("supports custom fusion scoring function", async () => {
      const searcher = new ChunkSearcher(db);

      const results = await searcher.hybrid({
        query: "Bun and SQLite",
        vector: [0.7071, 0.7071, 0.0, 0.0],
        fusion: {
          strategy: "custom",
          customFusion: (info) => {
            // Custom formula prioritizing chunks that match both modalities
            const hasBoth =
              info.vectorRank !== undefined && info.bm25Rank !== undefined;
            const cosine = info.cosineSimilarity ?? 0;
            return (hasBoth ? 100 : 0) + cosine * 10;
          },
        },
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe(3); // Has both vector and BM25 matches
      expect(results[0].score).toBeGreaterThan(100);
    });

    it("allows hybrid search using chunkId as vector basis", async () => {
      const searcher = new ChunkSearcher(db);

      const results = await searcher.hybrid({
        query: "superposition and entanglement",
        chunkId: 4, // Quantum computing chunk
        limit: 2,
      });

      expect(results.length).toBe(2);
      expect(results[0].source_id).toBe("src-science");
    });
  });

  describe("Unified Query Method & Error Handling", () => {
    it("dispatches correctly to hybrid, vector, and bm25 modes via sdk.search.query", async () => {
      const searcher = new ChunkSearcher(db);

      // Hybrid mode
      const hybridRes = await searcher.query({
        mode: "hybrid",
        query: "SQLite",
        vector: [0, 1, 0, 0],
      });
      expect(hybridRes.length).toBeGreaterThan(0);
      expect(hybridRes[0].fusionDetails).toBeDefined();

      // Vector mode
      const vectorRes = await searcher.query({
        mode: "vector",
        vector: [1, 0, 0, 0],
      });
      expect(vectorRes.length).toBeGreaterThan(0);
      expect(vectorRes[0].cosineSimilarity).toBeDefined();

      // BM25 mode
      const bm25Res = await searcher.query({
        mode: "bm25",
        query: "Quantum superposition",
      });
      expect(bm25Res.length).toBeGreaterThan(0);
      expect(bm25Res[0].bm25Score).toBeDefined();
    });

    it("throws clear error on invalid search mode", async () => {
      const searcher = new ChunkSearcher(db);

      await expect(
        searcher.query({ mode: "unsupported" } as any),
      ).rejects.toThrow(/Unsupported search mode/);
    });
  });

  describe("ShaleSDK & Ambient Scope Integration", () => {
    it("exposes search on ShaleSDK instance", async () => {
      const sdk = createExtensionSDK("test-search", "test", db);

      expect(sdk.search).toBeInstanceOf(ChunkSearcher);

      const results = await sdk.search.vector({
        vector: [1, 0, 0, 0],
        limit: 1,
      });
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(1);
    });

    it("supports search dynamic proxy and convenience functions within ambient scope", async () => {
      const sdk = createExtensionSDK("ambient-search", "test", db);

      await runWithSDK(sdk, async () => {
        // Dynamic proxy search.vector
        const vecRes = await search.vector({
          vector: [0, 1, 0, 0],
          limit: 1,
        });
        expect(vecRes.length).toBe(1);
        expect(vecRes[0].id).toBe(2);

        // Dynamic proxy search.bm25
        const bm25Res = await search.bm25({
          query: "Bun and TypeScript",
          limit: 1,
        });
        expect(bm25Res.length).toBe(1);
        expect(bm25Res[0].id).toBe(1);

        // Dynamic proxy search.hybrid
        const hybridRes = await search.hybrid({
          query: "SQLite database",
          vector: [0, 1, 0, 0],
          limit: 1,
        });
        expect(hybridRes.length).toBe(1);
        expect(hybridRes[0].id).toBe(2);

        // Top-level convenience searchVector
        const convVec = await searchVector({
          vector: [1, 0, 0, 0],
          limit: 1,
        });
        expect(convVec[0].id).toBe(1);

        // Top-level convenience searchBM25
        const convBm25 = await searchBM25({
          query: "Quantum entanglement",
          limit: 1,
        });
        expect([4, 5]).toContain(convBm25[0].id);
        expect(convBm25[0].matchedKeywords).toContain("entanglement");

        // Top-level convenience searchHybrid
        const convHybrid = await searchHybrid({
          query: "Shale Bun SQLite",
          vector: [0.7071, 0.7071, 0, 0],
          limit: 1,
        });
        expect(convHybrid[0].id).toBe(3);

        // Top-level convenience searchChunks (unified)
        const convUnified = await searchChunks({
          mode: "bm25",
          query: "Bun runtime",
          limit: 1,
        });
        expect([1, 3]).toContain(convUnified[0].id);
        expect(convUnified[0].text_content).toContain("Bun");
      });
    });
  });
});
