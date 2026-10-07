export type SearchMode = "hybrid" | "vector" | "bm25";

export interface GraphNode {
  id: number;
  name: string;
  type: string;
  namespace: string;
  stableId: string;
  canonicalId: number | null;
  degree: number;
  sourceUri?: string;
  sourceTitle?: string;
  chunksCount: number;
  chunks: Array<{ id: number; chunk_index: number; text_content: string }>;
}

export interface GraphEdge {
  id: string;
  status: string;
  context?: string;
  source: number;
  target: number;
  relation: string;
  weight: number;
}

export interface GraphData {
  generatedAt?: string;
  hostStartedAt?: number;
  truncated: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    totalEntities: number;
    totalEdges: number;
    totalSources: number;
    totalChunks: number;
    totalClaims: number;
  };
}

export interface SearchResult {
  id: number;
  source_id: string;
  chunk_index: number;
  text_content: string;
  source_title?: string;
  source_uri?: string;
  preview?: string;
  score?: number;
  distance?: number;
  cosineSimilarity?: number;
  entity_id?: number;
}
