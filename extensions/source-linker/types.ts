import type { Source, EvidenceInput } from "@shale/sdk";

export interface SourceCandidatePair {
  sourceA: Source;
  sourceB: Source;
  textScore: number;
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
  evidenceA?: EvidenceInput[];
  evidenceB?: EvidenceInput[];
  extractionRun?: string;
  model?: string;
  sourceIdA: string;
  sourceTitleA: string;
  sourceIdB: string;
  sourceTitleB: string;
  relation: string;
  reason: string;
  weight: number;
  textScore: number;
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
  candidatesPerChunk?: number;
  maxPairsPerRun?: number;
}
