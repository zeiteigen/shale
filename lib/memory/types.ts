export const MEMORY_LIMITS = Object.freeze({ summary: 8000, summaryTarget: 4000, snippets: 16,
  snippet: 1200, snippetCharacters: 12000, retainedCharacters: 32000, observations: 32 });

export interface MemoryLocator {
  originalChunkIndex?: number;
  start?: number;
  end?: number;
  [key: string]: unknown;
}
export interface PreparedSnippet {
  id?: string;
  text: string;
  kind: 'excerpt' | 'derived';
  locator: MemoryLocator;
  purpose: string;
}
export interface PreparedSourceMemory {
  summary: string;
  summaryMethod: 'model' | 'extractive' | 'metadata' | 'agent';
  snippets: PreparedSnippet[];
  coverage: { inputCharacters: number; sections: number; summarizedSections: number; method: string };
}
export interface MemoryChunkInput {
  text_content: string;
  chunk_type?: 'verbatim' | 'synthetic';
  chunk_index?: number;
  metadata?: Record<string, unknown>;
  entity_names?: string[];
}
export interface SourceObservationMetadata {captureOrigin?:'live-dom'|'public-fetch'|'tab-metadata';quality?:'metadata'|'partial'|'full'}

/** Read contract shared by the SDK, MCP, and browser without importing database code. */
export interface SourceMemoryRecord {
  source: { id: string; uri: string; title: string; type: string; origin: string; updated_at: number };
  version: number;
  summary: { text: string; versionId: number; method: PreparedSourceMemory['summaryMethod'] };
  snippets: Array<{ id: string; versionId: number; text: string; kind: PreparedSnippet['kind']; locator: MemoryLocator; purpose: string }>;
  coverage: PreparedSourceMemory['coverage'];
  freshness: { fingerprint: string; lastObservedAt: number | null; observation: SourceObservationMetadata | null };
  availability: string;
  completeOriginal: false;
}
