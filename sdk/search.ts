import { Database } from "bun:sqlite";
import { eng, removeStopwords } from "stopword";
import defaultDb from "../lib/db-init";
import { GraphIngestor } from "./graph";
import { expandGraphResults, type GraphSearchOptions } from "./graph/retrieval";
import type { BM25KeywordFusionStrategy, BM25SearchOptions, ChunkSearchResult, UnifiedSearchOptions } from "./types";

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

/** Full-text chunk retrieval with graph expansion. */
export class ChunkSearcher {
  private readonly db: Database;
  constructor(database?: Database) { this.db = database ?? defaultDb; }
  async graph(options: GraphSearchOptions) {
    if (options.mode !== undefined && options.mode !== "bm25") throw new Error("Unsupported search mode");
    const results = await this.bm25(options);
    if(options.minScore!==undefined && (!Number.isFinite(options.minScore) || options.minScore<0)) throw new Error('minScore must be finite and nonnegative');
    return expandGraphResults(this.db,new GraphIngestor('default',this.db),results.filter(r=>r.score>=(options.minScore ?? 0)),options);
  }
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

      if (options.excludeSourceId) {
        sql += ` AND c.source_id != $excludeSourceId`;
        params.$excludeSourceId = options.excludeSourceId;
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

      if (options.excludeSourceId) {
        sql += ` AND c.source_id != $excludeSourceId`;
        params.$excludeSourceId = options.excludeSourceId;
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

  async query(options: UnifiedSearchOptions): Promise<ChunkSearchResult[]> {
    if (options.mode !== "bm25") throw new Error("Unsupported search mode; supported mode is bm25");
    return this.bm25(options);
  }
}
export default ChunkSearcher;
