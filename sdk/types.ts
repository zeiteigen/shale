export interface ExtensionStateRecord {
  extension_id: string;
  state_key: string;
  value: string;
  updated_at: number;
}

export interface CheckpointRecord {
  id: string;
  extension_id: string;
  checkpoint_key: string;
  data: string;
  created_at: number;
  status: string;
}

export interface CheckpointItem<T = any> {
  id: string;
  extensionId: string;
  key: string;
  data: T;
  createdAt: number;
  status: string;
}

export interface CheckpointContext<T = any> {
  extensionId: string;
  checkpoints: CheckpointItem<T>[];
  count: number;
  latest: CheckpointItem<T> | null;
  earliest: CheckpointItem<T> | null;
  clear: () => number;
  resolve: (id: string) => boolean;
  get: (key: string) => CheckpointItem<T> | undefined;
}

export interface SaveCheckpointOptions {
  key?: string;
  id?: string;
  status?: string;
}

export interface HydratedChunk {
  id: number;
  source_id: string;
  chunk_index: number;
  chunk_type?: ChunkType;
  text_content: string;
}

export interface HydratedContext {
  source_id: string;
  uri?: string;
  title?: string;
  chunks: HydratedChunk[];
  combinedText: string;
}

export interface IngestEntityInput {
  name: string;
  type: string;
  id?: number;
  namespace?: string;
}

export interface IngestEdgeInput {
  source: string | number;
  target: string | number;
  relation: string;
  weight?: number;
  metadata?: string | Record<string, any>;
}

export type { Source, ChunkType } from "../lib/db";

export interface GetSourcesOptions {
  since?: number;
  limit?: number;
  origin?: string;
  type?: string;
}

export interface IngestGraphOptions {
  namespace?: string;
  entities: IngestEntityInput[];
  edges: IngestEdgeInput[];
}

export interface IngestGraphResult {
  namespace: string;
  entitiesInserted: number;
  edgesInserted: number;
  entityMap: Record<string, number>;
}

export interface SourceInput {
  id?: string;
  type: string;
  uri: string;
  origin: string;
  title: string;
  created_at?: number;
  updated_at?: number;
  hash?: string;
}

export interface ChunkInput {
  text_content: string;
  chunk_index?: number;
  chunk_type?: ChunkType;
  embedding: number[] | Float32Array;
  entity_names?: string[];
}

export interface IngestSourceAndChunksInput {
  source: SourceInput;
  chunks: ChunkInput[];
  namespace?: string;
}

export interface IngestSourceAndChunksResult {
  sourceId: string;
  chunkIds: number[];
  chunksCount: number;
}

export type {
  AIClientOptions,
  EmbedderOptions,
  OpenAIEmbeddingResponse,
  LLMOptions,
  LLMResponse,
  LLMImageInput,
  LLMImageObject,
  LLMImageDetail,
  LLMQueryInput,
} from "../lib/ai";

export type SearchMode = "hybrid" | "vector" | "bm25";

export type HybridFusionStrategy = "rrf" | "linear" | "custom";

export type BM25KeywordFusionStrategy =
  | "rrf"
  | "sum_scores"
  | "max_score"
  | "disjunctive";

export interface ChunkSearchResult {
  id: number;
  source_id: string;
  chunk_index: number;
  chunk_type?: ChunkType;
  text_content: string;
  source_title?: string | null;
  source_uri?: string | null;
  score: number;
  cosineSimilarity?: number;
  distance?: number;
  bm25Score?: number;
  preview?: string | null;
  matchedKeywords?: string[];
  rank?: number;
  fusionDetails?: {
    strategy: string;
    vectorRank?: number;
    vectorScore?: number;
    bm25Rank?: number;
    bm25Score?: number;
    rrfScore?: number;
    [key: string]: any;
  };
}

export interface HybridFusionItemInfo {
  chunkId: number;
  vectorRank?: number;
  vectorScore?: number;
  cosineSimilarity?: number;
  bm25Rank?: number;
  bm25Score?: number;
  item: Omit<ChunkSearchResult, "score">;
}

export interface HybridFusionOptions {
  strategy?: HybridFusionStrategy;
  rrfK?: number;
  vectorWeight?: number;
  bm25Weight?: number;
  customFusion?: (info: HybridFusionItemInfo) => number;
}

export interface VectorSearchOptions {
  query?: string;
  vector?: number[] | Float32Array;
  chunkId?: number;
  limit?: number;
  excludeSelf?: boolean;
  minSimilarity?: number;
  filterSourceId?: string;
  filterChunkType?: ChunkType;
  embedderOptions?: import("../lib/ai").EmbedderOptions;
}

export interface BM25SearchOptions {
  query?: string;
  keywords?: string[];
  limit?: number;
  candidateLimitPerKeyword?: number;
  keywordFusion?: BM25KeywordFusionStrategy;
  rrfK?: number;
  stopWords?: string[] | Set<string>;
  keepStopWords?: boolean;
  filterSourceId?: string;
  filterChunkType?: ChunkType;
  useSqliteStopwords?: boolean;
}

export interface HybridSearchOptions {
  query: string;
  vector?: number[] | Float32Array;
  chunkId?: number;
  limit?: number;
  vectorCandidateLimit?: number;
  bm25CandidateLimit?: number;
  fusion?: HybridFusionOptions;
  filterSourceId?: string;
  filterChunkType?: ChunkType;
  bm25Options?: Omit<BM25SearchOptions, "query" | "limit" | "filterSourceId" | "filterChunkType">;
  vectorOptions?: Omit<
    VectorSearchOptions,
    "query" | "vector" | "chunkId" | "limit" | "filterSourceId" | "filterChunkType"
  >;
}

export type UnifiedSearchOptions =
  | ({ mode: "hybrid" } & HybridSearchOptions)
  | ({ mode: "vector" } & VectorSearchOptions)
  | ({ mode: "bm25" } & BM25SearchOptions);

export * from "../lib/messages.types";

