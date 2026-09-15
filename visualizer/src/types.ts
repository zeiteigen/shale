export type SearchMode = "hybrid" | "vector" | "bm25";

export interface GraphNode {
  id: number;
  name: string;
  type: string;
  namespace: string;
  degree: number;
  sourceUri?: string;
  sourceTitle?: string;
  chunksCount: number;
  chunks: Array<{ id: number; chunk_index: number; text_content: string }>;
}

export interface GraphEdge {
  source: number;
  target: number;
  relation: string;
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    totalEntities: number;
    totalEdges: number;
    totalSources: number;
    totalChunks: number;
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
