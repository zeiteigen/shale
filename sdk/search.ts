import { Database } from "bun:sqlite";
import { eng, removeStopwords } from "stopword";
import defaultDb from "../lib/db-init";
import { GraphIngestor } from "./graph";
import { expandGraphResults, type GraphSearchOptions } from "./graph/retrieval";
import { ensureCosineIndex } from "../lib/cosine-index";
import { getIndexDimension, vectorBuffer } from "../lib/embedding-index";
import {
  assertEmbeddingProfile,
  embeddingProfile,
  readEmbeddingProfile,
} from "../lib/embedding-profile";
import {
  EmbedderClient,
  normalizeVectorDimensions,
  type EmbedderOptions,
  type EmbeddingClient,
} from "./embed";
import type {
  BM25KeywordFusionStrategy,
  BM25SearchOptions,
  ChunkSearchResult,
  HybridFusionItemInfo,
  HybridFusionOptions,
  HybridSearchOptions,
  UnifiedSearchOptions,
  VectorSearchOptions,
} from "./types";

export { eng, removeStopwords };

/**
 * Standard English stopwords from the stopword package to discard when breaking sentences into keywords.
 */
export const DEFAULT_STOP_WORDS = new Set<string>([...eng, "not"]);

export interface KeywordExtractionOptions {
  stopWords?: string[] | Set<string>;
  keepStopWords?: boolean;
  minTokenLength?: number;
  useSqliteStopwords?: boolean;
  db?: Database;
}

/**
 * Breaks a sentence down into keywords, discarding common stopwords like 'of', 'and', 'the', etc.
 * Uses the stopword npm package for stopword filtering, and supports SQLite json_each builtin filtering when useSqliteStopwords is enabled.
 */
export function extractKeywords(
  text: string,
  options?: KeywordExtractionOptions,
): string[] {
  if (!text || typeof text !== "string") {
    return [];
  }

  // Extract unicode word tokens
  const rawTokens = text.match(/[\p{L}\p{N}_]+/gu) || [];
  if (rawTokens.length === 0) {
    return [];
  }

  const normalizedTokens = rawTokens.map((t) => t.toLowerCase());
  const minLen = options?.minTokenLength ?? 2;

  if (options?.keepStopWords) {
    return Array.from(
      new Set(
        normalizedTokens.filter((t) => t.length >= minLen || /^\d+$/.test(t)),
      ),
    );
  }

  // Build active stop word list
  const stopWordsList = options?.stopWords
    ? (options.stopWords instanceof Set
        ? Array.from(options.stopWords)
        : options.stopWords
      ).map((w) => w.toLowerCase())
    : Array.from(DEFAULT_STOP_WORDS);

  // Optional SQLite-side stopword filtering using json_each builtin
  if (options?.useSqliteStopwords && options.db) {
    try {
      const query = `
        WITH input_tokens AS (
          SELECT lower(value) AS word FROM json_each($tokens)
        ),
        stop_words AS (
          SELECT lower(value) AS word FROM json_each($stopwords)
        )
        SELECT DISTINCT word FROM input_tokens
        WHERE word NOT IN (SELECT word FROM stop_words)
          AND (length(word) >= $minLen OR word GLOB '[0-9]*')
      `;
      const rows = options.db
        .query<
          { word: string },
          { $tokens: string; $stopwords: string; $minLen: number }
        >(query)
        .all({
          $tokens: JSON.stringify(normalizedTokens),
          $stopwords: JSON.stringify(stopWordsList),
          $minLen: minLen,
        });

      const sqliteFiltered = rows.map((r: { word: string }) => r.word);
      if (sqliteFiltered.length > 0) {
        return sqliteFiltered;
      }
    } catch {
      // Fall through to in-memory filter if SQLite json_each fails
    }
  }

  // Fast in-memory stop word filter using 'stopword' package
  const withoutStopwords = removeStopwords(normalizedTokens, stopWordsList);
  const filtered = withoutStopwords.filter(
    (token) => token.length >= minLen || /^\d+$/.test(token),
  );

  // If every token was filtered out as a stop word (e.g., "to be and to be"),
  // fall back to non-empty tokens so queries do not return empty.
  const result = filtered.length > 0 ? filtered : normalizedTokens;
  return Array.from(new Set(result));
}

/**
 * Vector similarity and full-text search engine for chunk retrieval.
 */
export class ChunkSearcher {
  private readonly db: Database;
  private readonly embedder: EmbeddingClient;

  constructor(database?: Database, embedder?: EmbeddingClient) {
    this.db = database ?? defaultDb;
    this.embedder = embedder ?? new EmbedderClient();
  }

  async graph(options: GraphSearchOptions) {
    const results = options.mode === 'bm25' ? await this.bm25(options)
      : options.mode === 'vector' ? await this.vector(options) : await this.hybrid(options);
    if(options.minScore!==undefined && (!Number.isFinite(options.minScore) || options.minScore<0)) throw new Error('minScore must be finite and nonnegative');
    return expandGraphResults(this.db,new GraphIngestor('default',this.db),results.filter(r=>r.score>=(options.minScore ?? 0)),options);
  }

  /**
   * Discovers the target embedding dimension configured in sqlite-vec vector_index virtual table.
   */
  getTargetDimension(): number {
    return getIndexDimension(this.db);
  }

  /**
   * Helper to format a vector as a Uint8Array buffer matching sqlite-vec expectations.
   */
  private prepareVectorBuffer(vec: number[] | Float32Array): Uint8Array {
    const targetDim = this.getTargetDimension();
    const rawArray = Array.isArray(vec) ? vec : Array.from(vec);
    const normalized = normalizeVectorDimensions(rawArray, targetDim);
    return vectorBuffer(normalized, targetDim);
  }

  /**
   * Mode 2: Vector Embeddings Only Search
   * Supports similarity to query text (auto-embedded), direct vector, or KNN to a pre-existing chunk.
   * Computes and includes cosine similarity in each result.
   */
  async vector(options: VectorSearchOptions): Promise<ChunkSearchResult[]> {
    const limit = options.limit ?? 10;
    if (limit <= 0) return [];
    ensureCosineIndex(this.db);

    let queryBuffer: Uint8Array;
    let excludeChunkId: number | null = null;

    if (options.chunkId !== undefined) {
      // KNN search from pre-existing chunk
      const row = this.db
        .query<{ embedding: Uint8Array }, { $id: number }>(
          "SELECT embedding FROM vector_index WHERE rowid = $id",
        )
        .get({ $id: options.chunkId });

      if (!row || !row.embedding) {
        throw new Error(
          `Chunk with id ${options.chunkId} not found or has no embedding in vector_index`,
        );
      }

      queryBuffer = row.embedding;
      if (options.excludeSelf ?? true) {
        excludeChunkId = options.chunkId;
      }
    } else if (options.vector) {
      const profile =
        options.embeddingProfile ?? embeddingProfile(options.vector);
      if (profile) assertEmbeddingProfile(this.db, profile);
      else if (readEmbeddingProfile(this.db))
        throw new Error(
          "A precomputed search vector requires its embeddingProfile",
        );
      queryBuffer = this.prepareVectorBuffer(options.vector);
    } else if (options.query) {
      const vector = await this.embedder.embed(
        options.query,
        options.embedderOptions,
      );
      const profile = embeddingProfile(vector);
      if (profile) assertEmbeddingProfile(this.db, profile);
      queryBuffer = this.prepareVectorBuffer(vector);
    } else {
      throw new Error(
        "Vector search requires either 'query' (text), 'vector' (numbers), or 'chunkId' (existing chunk ID).",
      );
    }

    // Joined filters must constrain the distance query before limiting results.
    const filtered = Boolean(options.filterSourceId || options.filterChunkType);
    const distance = filtered ? "vec_distance_cosine(v.embedding, $query)" : "v.distance";
    const fetchK = excludeChunkId !== null ? limit + 1 : limit;

    let sql = `
      SELECT 
        c.id, 
        c.source_id, 
        c.chunk_index, 
        c.chunk_type,
        c.text_content, 
        ${distance} AS distance,
        (1.0 - vec_distance_cosine(v.embedding, $query)) AS cosine_similarity,
        s.title AS source_title,
        s.uri AS source_uri
      FROM vector_index v
      JOIN chunks c ON c.id = v.rowid
      LEFT JOIN sources s ON c.source_id = s.id
      WHERE ${filtered ? "1 = 1" : "v.embedding MATCH $query AND k = $fetchK"}
    `;

    const params: Record<string, any> = {
      $query: queryBuffer,
    };
    if (!filtered) params.$fetchK = fetchK;

    if (options.filterSourceId) {
      sql += ` AND (c.source_id = $sourceId OR s.id = $sourceId OR s.uri = $sourceId)`;
      params.$sourceId = options.filterSourceId;
    }

    if (options.filterChunkType) {
      sql += ` AND c.chunk_type = $filterChunkType`;
      params.$filterChunkType = options.filterChunkType;
    }

    if (filtered && excludeChunkId !== null) {
      sql += " AND v.rowid != $excludeId";
      params.$excludeId = excludeChunkId;
    }
    if (filtered && options.minSimilarity !== undefined) {
      sql += ` AND (1.0 - ${distance}) >= $minSimilarity`;
      params.$minSimilarity = options.minSimilarity;
    }
    sql += " ORDER BY distance, c.id";
    if (filtered) {
      sql += " LIMIT $limit";
      params.$limit = limit;
    }

    const rows = this.db.query<any, any>(sql).all(params);

    const results: ChunkSearchResult[] = [];
    for (const row of rows) {
      if (excludeChunkId !== null && row.id === excludeChunkId) {
        continue;
      }

      const rawCosine =
        typeof row.cosine_similarity === "number"
          ? row.cosine_similarity
          : 1.0 - row.distance;

      // Clamp cosine similarity to [-1.0, 1.0] to guard against floating-point epsilon
      const cosineSimilarity = Math.max(-1.0, Math.min(1.0, rawCosine));

      if (
        options.minSimilarity !== undefined &&
        cosineSimilarity < options.minSimilarity
      ) {
        continue;
      }

      results.push({
        id: row.id,
        source_id: row.source_id,
        chunk_index: row.chunk_index,
        chunk_type: row.chunk_type,
        text_content: row.text_content,
        source_title: row.source_title,
        source_uri: row.source_uri,
        score: cosineSimilarity,
        cosineSimilarity,
        distance: row.distance,
        rank: results.length + 1,
      });

      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }

  /**
   * Mode 3: BM25 Only Search
   * Deconstructs sentences into keywords, filters stopwords (e.g. 'of', 'and', 'the'),
   * and fuses results for all keywords using RRF, score sum, or disjunction.
   */
  async bm25(options: BM25SearchOptions): Promise<ChunkSearchResult[]> {
    const limit = options.limit ?? 10;
    if (limit <= 0) return [];

    let keywords = options.keywords;
    if (!keywords || keywords.length === 0) {
      if (!options.query) {
        return [];
      }
      keywords = extractKeywords(options.query, {
        stopWords: options.stopWords,
        keepStopWords: options.keepStopWords,
        useSqliteStopwords: options.useSqliteStopwords,
        db: this.db,
      });
    }

    if (keywords.length === 0) {
      return [];
    }

    const fusionStrategy = options.keywordFusion ?? "rrf";
    const candidateLimit = options.candidateLimitPerKeyword ?? 50;

    // Fast-path: Disjunctive FTS5 matching (MATCH 'kw1 OR kw2 ...')
    if (fusionStrategy === "disjunctive" || keywords.length === 1) {
      const matchQuery = keywords
        .map((k) => `"${k.replace(/"/g, '""')}"`)
        .join(" OR ");
      let sql = `
        SELECT 
          c.id, 
          c.source_id, 
          c.chunk_index, 
          c.chunk_type,
          c.text_content, 
          s.title AS source_title, 
          s.uri AS source_uri,
          bm25(chunks_fts) AS bm25_score,
          snippet(chunks_fts, -1, '<mark>', '</mark>', '...', 15) AS preview
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        LEFT JOIN sources s ON c.source_id = s.id
        WHERE chunks_fts MATCH $matchQuery
      `;

      const params: Record<string, any> = { $matchQuery: matchQuery };
      if (options.filterSourceId) {
        sql += ` AND (c.source_id = $sourceId OR s.id = $sourceId OR s.uri = $sourceId)`;
        params.$sourceId = options.filterSourceId;
      }

      if (options.filterChunkType) {
        sql += ` AND c.chunk_type = $filterChunkType`;
        params.$filterChunkType = options.filterChunkType;
      }

      sql += ` ORDER BY bm25_score LIMIT $limit`;
      params.$limit = limit;

      const rows = this.db.query<any, any>(sql).all(params);
      return rows.map((r, idx) => {
        // FTS5 bm25 produces negative numbers where lower is better. Invert to positive for score.
        const positiveScore = -r.bm25_score;
        const matched = keywords!.filter((kw) =>
          r.text_content.toLowerCase().includes(kw.toLowerCase()),
        );
        return {
          id: r.id,
          source_id: r.source_id,
          chunk_index: r.chunk_index,
          chunk_type: r.chunk_type,
          text_content: r.text_content,
          source_title: r.source_title,
          source_uri: r.source_uri,
          score: positiveScore,
          bm25Score: r.bm25_score,
          preview: r.preview,
          matchedKeywords: matched.length > 0 ? matched : keywords,
          rank: idx + 1,
        };
      });
    }

    // Multi-keyword fusion path:
    // Execute individual BM25 search for each keyword and fuse results
    interface KeywordCandidate {
      row: {
        id: number;
        source_id: string;
        chunk_index: number;
        chunk_type?: import("../lib/db").ChunkType;
        text_content: string;
        source_title: string | null;
        source_uri: string | null;
        bm25_score: number;
        preview: string;
      };
      rank: number;
    }

    const keywordResults = new Map<string, KeywordCandidate[]>();

    for (const keyword of keywords) {
      const sanitized = `"${keyword.replace(/"/g, '""')}"`;
      let sql = `
        SELECT 
          c.id, 
          c.source_id, 
          c.chunk_index, 
          c.chunk_type,
          c.text_content, 
          s.title AS source_title, 
          s.uri AS source_uri,
          bm25(chunks_fts) AS bm25_score,
          snippet(chunks_fts, -1, '<mark>', '</mark>', '...', 15) AS preview
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        LEFT JOIN sources s ON c.source_id = s.id
        WHERE chunks_fts MATCH $keyword
      `;

      const params: Record<string, any> = { $keyword: sanitized };
      if (options.filterSourceId) {
        sql += ` AND (c.source_id = $sourceId OR s.id = $sourceId OR s.uri = $sourceId)`;
        params.$sourceId = options.filterSourceId;
      }

      if (options.filterChunkType) {
        sql += ` AND c.chunk_type = $filterChunkType`;
        params.$filterChunkType = options.filterChunkType;
      }

      sql += ` ORDER BY bm25_score LIMIT $candidateLimit`;
      params.$candidateLimit = candidateLimit;

      const rows = this.db.query<any, any>(sql).all(params);
      const candidates: KeywordCandidate[] = rows.map((r, i) => ({
        row: r,
        rank: i + 1,
      }));
      keywordResults.set(keyword, candidates);
    }

    // Fuse across all keywords
    const rrfK = options.rrfK ?? 60;
    const chunkMap = new Map<
      number,
      {
        row: KeywordCandidate["row"];
        score: number;
        bestBm25: number;
        preview: string;
        matched: string[];
      }
    >();

    for (const [kw, candidates] of keywordResults.entries()) {
      for (const cand of candidates) {
        const id = cand.row.id;
        const current = chunkMap.get(id);

        if (!current) {
          let initialScore = 0;
          if (fusionStrategy === "rrf") {
            initialScore = 1.0 / (rrfK + cand.rank);
          } else if (fusionStrategy === "sum_scores") {
            initialScore = -cand.row.bm25_score;
          } else if (fusionStrategy === "max_score") {
            initialScore = -cand.row.bm25_score;
          }

          chunkMap.set(id, {
            row: cand.row,
            score: initialScore,
            bestBm25: cand.row.bm25_score,
            preview: cand.row.preview,
            matched: [kw],
          });
        } else {
          if (fusionStrategy === "rrf") {
            current.score += 1.0 / (rrfK + cand.rank);
          } else if (fusionStrategy === "sum_scores") {
            current.score += -cand.row.bm25_score;
          } else if (fusionStrategy === "max_score") {
            current.score = Math.max(current.score, -cand.row.bm25_score);
          }

          if (cand.row.bm25_score < current.bestBm25) {
            current.bestBm25 = cand.row.bm25_score;
            current.preview = cand.row.preview;
          }
          current.matched.push(kw);
        }
      }
    }

    const sortedChunks = Array.from(chunkMap.values()).sort(
      (a, b) => b.score - a.score,
    );

    return sortedChunks.slice(0, limit).map((c, idx) => ({
      id: c.row.id,
      source_id: c.row.source_id,
      chunk_index: c.row.chunk_index,
      chunk_type: c.row.chunk_type,
      text_content: c.row.text_content,
      source_title: c.row.source_title,
      source_uri: c.row.source_uri,
      score: c.score,
      bm25Score: c.bestBm25,
      preview: c.preview,
      matchedKeywords: c.matched,
      rank: idx + 1,
    }));
  }

  /**
   * Mode 1: Hybrid Search
   * Combines vector embeddings and BM25 full-text search with configurable fusion:
   * Reciprocal Rank Fusion (RRF), linear weighted score combination, or custom scoring.
   */
  async hybrid(options: HybridSearchOptions): Promise<ChunkSearchResult[]> {
    const limit = options.limit ?? 10;
    if (limit <= 0) return [];

    const vectorLimit = options.vectorCandidateLimit ?? Math.max(limit * 2, 50);
    const bm25Limit = options.bm25CandidateLimit ?? Math.max(limit * 2, 50);

    // Concurrently fetch candidates from Vector and BM25
    const [vectorCandidates, bm25Candidates] = await Promise.all([
      this.vector({
        query: options.vector || options.chunkId ? undefined : options.query,
        vector: options.vector,
        chunkId: options.chunkId,
        limit: vectorLimit,
        filterSourceId: options.filterSourceId,
        filterChunkType: options.filterChunkType,
        ...options.vectorOptions,
      }),
      this.bm25({
        query: options.query,
        limit: bm25Limit,
        filterSourceId: options.filterSourceId,
        filterChunkType: options.filterChunkType,
        ...options.bm25Options,
      }),
    ]);

    const fusion = options.fusion ?? {};
    const strategy = fusion.strategy ?? "rrf";
    const rrfK = fusion.rrfK ?? 60;
    const vectorWeight = fusion.vectorWeight ?? 1.0;
    const bm25Weight = fusion.bm25Weight ?? 1.0;

    // Index vector candidates
    const vectorMap = new Map<
      number,
      { cand: ChunkSearchResult; rank: number }
    >();
    vectorCandidates.forEach((cand, idx) => {
      vectorMap.set(cand.id, { cand, rank: idx + 1 });
    });

    // Index BM25 candidates
    const bm25Map = new Map<
      number,
      { cand: ChunkSearchResult; rank: number }
    >();
    bm25Candidates.forEach((cand, idx) => {
      bm25Map.set(cand.id, { cand, rank: idx + 1 });
    });

    // Union of all candidate chunk IDs
    const allIds = new Set<number>([...vectorMap.keys(), ...bm25Map.keys()]);

    const fusedItems: ChunkSearchResult[] = [];

    if (strategy === "rrf") {
      // Reciprocal Rank Fusion
      for (const id of allIds) {
        const v = vectorMap.get(id);
        const b = bm25Map.get(id);

        const vRank = v ? v.rank : undefined;
        const bRank = b ? b.rank : undefined;

        const vRrf = vRank !== undefined ? vectorWeight / (rrfK + vRank) : 0;
        const bRrf = bRank !== undefined ? bm25Weight / (rrfK + bRank) : 0;
        const rrfScore = vRrf + bRrf;

        const base = (v ? v.cand : b?.cand)!;

        fusedItems.push({
          id: base.id,
          source_id: base.source_id,
          chunk_index: base.chunk_index,
          chunk_type: base.chunk_type,
          text_content: base.text_content,
          source_title: base.source_title,
          source_uri: base.source_uri,
          score: rrfScore,
          cosineSimilarity: v?.cand.cosineSimilarity,
          distance: v?.cand.distance,
          bm25Score: b?.cand.bm25Score,
          preview: b?.cand.preview,
          matchedKeywords: b?.cand.matchedKeywords,
          fusionDetails: {
            strategy: "rrf",
            vectorRank: vRank,
            bm25Rank: bRank,
            rrfScore,
            vectorWeight,
            bm25Weight,
          },
        });
      }
    } else if (strategy === "linear") {
      // Weighted Normalized Linear Score Fusion
      // Normalize BM25 scores: inverted since lower is better in FTS5
      let minBm25 = Infinity;
      let maxBm25 = -Infinity;
      for (const { cand } of bm25Map.values()) {
        if (cand.bm25Score !== undefined) {
          const inv = -cand.bm25Score;
          if (inv < minBm25) minBm25 = inv;
          if (inv > maxBm25) maxBm25 = inv;
        }
      }
      const bm25Range = maxBm25 - minBm25;

      for (const id of allIds) {
        const v = vectorMap.get(id);
        const b = bm25Map.get(id);

        // Cosine similarity is in [-1, 1], normalize to [0, 1]
        const normVector =
          v?.cand.cosineSimilarity !== undefined
            ? (v.cand.cosineSimilarity + 1.0) / 2.0
            : 0;

        // BM25 normalized to [0, 1]
        let normBm25 = 0;
        if (b?.cand.bm25Score !== undefined) {
          normBm25 =
            bm25Range > 0 ? (-b.cand.bm25Score - minBm25) / bm25Range : 1.0;
        }

        const totalWeight = vectorWeight + bm25Weight;
        const score =
          totalWeight > 0
            ? (vectorWeight * normVector + bm25Weight * normBm25) / totalWeight
            : 0;

        const base = (v ? v.cand : b?.cand)!;

        fusedItems.push({
          id: base.id,
          source_id: base.source_id,
          chunk_index: base.chunk_index,
          chunk_type: base.chunk_type,
          text_content: base.text_content,
          source_title: base.source_title,
          source_uri: base.source_uri,
          score,
          cosineSimilarity: v?.cand.cosineSimilarity,
          distance: v?.cand.distance,
          bm25Score: b?.cand.bm25Score,
          preview: b?.cand.preview,
          matchedKeywords: b?.cand.matchedKeywords,
          fusionDetails: {
            strategy: "linear",
            vectorRank: v?.rank,
            bm25Rank: b?.rank,
            normVector,
            normBm25,
            vectorWeight,
            bm25Weight,
          },
        });
      }
    } else if (strategy === "custom" && fusion.customFusion) {
      // User-supplied custom fusion callback
      for (const id of allIds) {
        const v = vectorMap.get(id);
        const b = bm25Map.get(id);
        const base = (v ? v.cand : b?.cand)!;

        const itemInfo: HybridFusionItemInfo = {
          chunkId: id,
          vectorRank: v?.rank,
          vectorScore: v?.cand.score,
          cosineSimilarity: v?.cand.cosineSimilarity,
          bm25Rank: b?.rank,
          bm25Score: b?.cand.bm25Score,
          item: {
            id: base.id,
            source_id: base.source_id,
            chunk_index: base.chunk_index,
            chunk_type: base.chunk_type,
            text_content: base.text_content,
            source_title: base.source_title,
            source_uri: base.source_uri,
            cosineSimilarity: v?.cand.cosineSimilarity,
            distance: v?.cand.distance,
            bm25Score: b?.cand.bm25Score,
            preview: b?.cand.preview,
            matchedKeywords: b?.cand.matchedKeywords,
          },
        };

        const score = fusion.customFusion(itemInfo);

        fusedItems.push({
          id: base.id,
          source_id: base.source_id,
          chunk_index: base.chunk_index,
          chunk_type: base.chunk_type,
          text_content: base.text_content,
          source_title: base.source_title,
          source_uri: base.source_uri,
          score,
          cosineSimilarity: v?.cand.cosineSimilarity,
          distance: v?.cand.distance,
          bm25Score: b?.cand.bm25Score,
          preview: b?.cand.preview,
          matchedKeywords: b?.cand.matchedKeywords,
          fusionDetails: {
            strategy: "custom",
            vectorRank: v?.rank,
            bm25Rank: b?.rank,
          },
        });
      }
    }

    fusedItems.sort((a, b) => b.score - a.score);

    return fusedItems.slice(0, limit).map((item, idx) => ({
      ...item,
      rank: idx + 1,
    }));
  }

  /**
   * Unified search interface accepting options with a mode specifier:
   * 'hybrid', 'vector', or 'bm25'.
   */
  async query(options: UnifiedSearchOptions): Promise<ChunkSearchResult[]> {
    switch (options.mode) {
      case "hybrid":
        return this.hybrid(options);
      case "vector":
        return this.vector(options);
      case "bm25":
        return this.bm25(options);
      default:
        throw new Error(
          `Unsupported search mode: ${(options as any).mode}. Supported modes are: "hybrid", "vector", "bm25".`,
        );
    }
  }
}

export default ChunkSearcher;
