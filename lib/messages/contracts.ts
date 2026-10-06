import type { GraphChannelDefinitions } from "./graph-contracts";
import type { BrowserChannelDefinitions } from "./browser-contracts";
import type { WebChannelDefinitions } from "./web-contracts";
export type {
  WebPageParseRequest,
  WebPageParseResponse,
} from "./web-contracts";
import type { PreparedSourceClaim } from "../../sdk/graph/prepared";

// ---------------------------------------------------------------------------
// Built-in Channel Schemas
// ---------------------------------------------------------------------------

// 1. File Processor: "file:process" & "files:process"
export interface ProcessFileOptions {
  /** If true, skip vector embeddings generation for Phase 1 local GPU optimization */
  deferEmbedding?: boolean;
  /** Execution timeout in milliseconds */
  timeoutMs?: number;
  /** Custom prompt override */
  customPrompt?: string;
  /** Precomputed embedding vector if already computed */
  precomputedEmbedding?: number[];
  /** Target graph/data namespace */
  namespace?: string;
  /** Concurrency limit when processing multiple files */
  concurrency?: number;
  [key: string]: any;
}

export interface ProcessFilesBatchItem {
  /** Absolute or relative path to the file */
  filePath: string;
  /** Optional MIME type */
  mimeType?: string;
  /** Optional high-level file category */
  fileType?: string;
  /** Optional container/context entity name */
  contextEntity?: string;
  /** Item-specific processing options */
  options?: ProcessFileOptions;
}

export interface ProcessFileRequest {
  /** Absolute or relative path to the file to process (single file mode) */
  filePath?: string;
  /** Optional array of file paths to process in bulk */
  filePaths?: string[];
  /** Optional array of detailed file items to process in bulk */
  files?: Array<string | ProcessFilesBatchItem>;
  /** Optional MIME type (e.g. "image/png", "application/pdf") */
  mimeType?: string;
  /** Optional high-level file category (e.g. "image", "audio", "markdown", "pdf") */
  fileType?: string;
  /** Optional container/context entity name (e.g. vault name, folder name, repository) */
  contextEntity?: string;
  /** Processing options passed down to the file handler */
  options?: ProcessFileOptions;
}

import type { ChunkType } from "../db";

export interface ProcessedChunk {
  chunk_index: number;
  chunk_type?: ChunkType;
  text_content: string;
  embedding?: number[] | Float32Array;
  entity_names?: string[];
  metadata?: Record<string, any>;
}

export interface ProcessedEntity {
  name: string;
  type: string;
  namespace?: string;
  identityKey?: string;
}

export interface ProcessedEdge {
  source: string;
  target: string;
  relation: string;
  weight?: number;
  metadata?: Record<string, any>;
}

export interface ProcessFileResponse {
  success: boolean;
  filePath: string;
  fileType: string;
  title: string;
  uri: string;
  description?: string;
  knowledge?: PreparedSourceClaim[];
  chunks: ProcessedChunk[];
  entities: ProcessedEntity[];
  edges: ProcessedEdge[];
  metadata?: Record<string, any>;
  error?: string;
  /** Populated when invoked in batch mode */
  results?: ProcessFileResponse[];
  totalProcessed?: number;
  totalFailed?: number;
}

// 2. Bulk File Processor: "files:process" & "file:process-batch"
export interface ProcessFilesBatchRequest {
  /** Array of file paths or detailed file items to process in bulk */
  files?: Array<string | ProcessFilesBatchItem>;
  /** Convenience shorthand for list of file paths */
  filePaths?: string[];
  /** Shared fileType if all files share the same category (e.g. "image") */
  fileType?: string;
  /** Shared container/context entity name */
  contextEntity?: string;
  /** Batch processing options */
  options?: ProcessFileOptions;
}

export interface ProcessFilesBatchResponse {
  success: boolean;
  totalProcessed: number;
  totalFailed: number;
  results: ProcessFileResponse[];
  errors?: Array<{ filePath: string; error: string }>;
}

// 3. File Capability Query: "file:can-process" & "files:can-process"
export interface CanProcessFileRequest {
  filePath: string;
  mimeType?: string;
  fileType?: string;
}

export interface CanProcessFileResponse {
  canProcess: boolean;
  supportedBy?: string;
  priority?: number;
}

export interface CanProcessFilesRequest {
  filePaths: string[];
  fileType?: string;
}

export interface CanProcessFilesResponse {
  canProcessAll: boolean;
  results: Record<string, CanProcessFileResponse>;
}

// 3. Source Ingestion Event: "source:ingested"
export interface SourceIngestedEvent {
  sourceId: string;
  type: string;
  uri: string;
  title: string;
  origin: string;
  chunksCount: number;
  namespace?: string;
  timestamp: number;
}

// 4. Entity Linking Request: "graph:link-entities"
export interface LinkEntitiesRequest {
  sourceEntity: string;
  targetEntity: string;
  relation: string;
  weight?: number;
  namespace?: string;
  bidirectional?: boolean;
  metadata?: Record<string, any>;
}

export interface LinkEntitiesResponse {
  success: boolean;
  edgesCreated: number;
  error?: string;
}

// 5. Content Summarization: "content:summarize" & "content:summarize-batch"
export interface SummarizeContentRequest {
  content: string;
  title?: string;
  maxLength?: number;
  targetTokens?: number;
  style?: "concise" | "detailed" | "bullet-points" | "atomic";
  systemPrompt?: string;
  timeoutMs?: number;
}

export interface SummarizeContentResponse {
  success: boolean;
  summary: string;
  keyPoints?: string[];
  topics?: string[];
  tokensUsed?: number;
  error?: string;
}

export interface SummarizeContentBatchItem {
  id?: string;
  content: string;
  title?: string;
  maxLength?: number;
  targetTokens?: number;
  style?: "concise" | "detailed" | "bullet-points" | "atomic";
  systemPrompt?: string;
}

export interface SummarizeContentBatchRequest {
  /** Array of items to summarize */
  items?: SummarizeContentBatchItem[];
  /** Convenience shorthand for list of text contents */
  contents?: string[];
  style?: "concise" | "detailed" | "bullet-points" | "atomic";
  systemPrompt?: string;
  timeoutMs?: number;
}

export interface SummarizeContentBatchResponse {
  success: boolean;
  totalProcessed: number;
  results: Array<SummarizeContentResponse & { id?: string }>;
  error?: string;
}

// 6. Database Backup: "system:backup"
export interface SystemBackupRequest {
  reason?: string;
  destinationDir?: string;
}

export interface SystemBackupResponse {
  success: boolean;
  backupPath?: string;
  sizeBytes?: number;
  error?: string;
}

// 7. Cross-Extension Search: "search:query"
export interface SearchQueryRequest {
  query: string;
  mode?: "hybrid" | "vector" | "bm25";
  limit?: number;
  namespace?: string;
  origin?: string;
}

export interface SearchQueryResponse {
  results: Array<{
    id: number;
    sourceId: string;
    title?: string | null;
    uri?: string | null;
    textContent: string;
    score: number;
  }>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Type-Safe Channel Map
// ---------------------------------------------------------------------------

export interface BuiltinChannelDefinitions
  extends
    GraphChannelDefinitions,
    WebChannelDefinitions,
    BrowserChannelDefinitions {
  "file:process": {
    type: "request";
    request: ProcessFileRequest;
    response: ProcessFileResponse;
  };
  "files:process": {
    type: "request";
    request: ProcessFilesBatchRequest;
    response: ProcessFilesBatchResponse;
  };
  "file:process-batch": {
    type: "request";
    request: ProcessFilesBatchRequest;
    response: ProcessFilesBatchResponse;
  };
  "file:can-process": {
    type: "request";
    request: CanProcessFileRequest;
    response: CanProcessFileResponse;
  };
  "files:can-process": {
    type: "request";
    request: CanProcessFilesRequest;
    response: CanProcessFilesResponse;
  };
  "source:ingested": {
    type: "event";
    payload: SourceIngestedEvent;
  };
  "graph:link-entities": {
    type: "request";
    request: LinkEntitiesRequest;
    response: LinkEntitiesResponse;
  };
  "content:summarize": {
    type: "request";
    request: SummarizeContentRequest;
    response: SummarizeContentResponse;
  };
  "content:summarize-batch": {
    type: "request";
    request: SummarizeContentBatchRequest;
    response: SummarizeContentBatchResponse;
  };
  "system:backup": {
    type: "request";
    request: SystemBackupRequest;
    response: SystemBackupResponse;
  };
  "search:query": {
    type: "request";
    request: SearchQueryRequest;
    response: SearchQueryResponse;
  };
}

export type BuiltinRequestChannels = {
  [K in keyof BuiltinChannelDefinitions]: BuiltinChannelDefinitions[K] extends {
    type: "request";
  }
    ? K
    : never;
}[keyof BuiltinChannelDefinitions];

export type BuiltinEventChannels = {
  [K in keyof BuiltinChannelDefinitions]: BuiltinChannelDefinitions[K] extends {
    type: "event";
  }
    ? K
    : never;
}[keyof BuiltinChannelDefinitions];
