import type { Source } from "@shale/sdk";

export interface SourceCandidatePair {
  sourceA: Source;
  sourceB: Source;
  knnSimilarity: number;
  matchedChunkIds: number[];
}

export interface LLMLinkAnalysis {
  shouldLink: boolean;
  relation: string;
  reason: string;
  weight: number;
  entityResolutions: EntityResolution[];
}

export interface EntityResolution {
  canonicalName: string;
  entityType: string;
  mentionsA: string[];
  mentionsB: string[];
  confidence: number;
  reason: string;
}

export interface DiscoveredLink {
  sourceIdA: string;
  sourceTitleA: string;
  sourceIdB: string;
  sourceTitleB: string;
  relation: string;
  reason: string;
  weight: number;
  knnSimilarity: number;
  entityResolutions: EntityResolution[];
}

export interface ProcessLinksResult {
  sourcesAnalyzed: number;
  candidatePairsEvaluated: number;
  linksCreated: number;
  edgesCommitted: number;
  watermarkAdvancedTo: number;
  checkpointsResolved: number;
}

export interface RunOptions {
  forceAll?: boolean;
  knnK?: number;
  minKnnSimilarity?: number;
  maxPairsPerRun?: number;
}
