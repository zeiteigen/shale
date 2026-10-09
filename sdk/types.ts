import type { ChunkType } from "../lib/db";

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
  /** Durable identity; distinct entities may share a display name. */
  stableId?: string;
  aliases?: string[];
}

export interface IngestEdgeInput {
  source: string | number;
  target: string | number;
  relation: string;
  weight?: number;
  metadata?: string | Record<string, any>;
  /** First-class assertion fields. Legacy metadata is retained as qualifiers. */
  claim?: Omit<import('./graph/types').ClaimInput, 'subject' | 'predicate' | 'object'>;
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
  skipped?: "excluded";
}

export type {
  AIClientOptions,
  LLMOptions,
  LLMResponse,
  LLMImageInput,
  LLMImageObject,
  LLMImageDetail,
  LLMQueryInput,
} from "../lib/ai";

export type SearchMode = "bm25";


export type BM25KeywordFusionStrategy =
  "rrf" | "sum_scores" | "max_score" | "disjunctive";

export interface ChunkSearchResult {
  id: number;
  source_id: string;
  chunk_index: number;
  chunk_type?: ChunkType;
  text_content: string;
  source_title?: string | null;
  source_uri?: string | null;
  score: number;
  bm25Score?: number;
  preview?: string | null;
  matchedKeywords?: string[];
  rank?: number;
  fusionDetails?: {
    strategy: string;
    bm25Rank?: number;
    bm25Score?: number;
    rrfScore?: number;
    [key: string]: any;
  };
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
  excludeSourceId?: string;
  filterChunkType?: ChunkType;
  useSqliteStopwords?: boolean;
}

export type UnifiedSearchOptions = { mode: "bm25" } & BM25SearchOptions;

export * from "../lib/messages.types";
