export interface KnowledgeGraphSettings {
  resolverEnabled: boolean;
  selfNames: string[];
  selfEmails: string[];
  selfHandles: string[];
  maxAdjudicationsPerRun: number;
  linkageMode: 'off' | 'shadow' | 'active';
  linkageSameThreshold: number;
  linkagePersonSameThreshold: number;
  linkageDifferentThreshold: number;
  linkageRefitMinLabels: number;
  maxNearDuplicatesPerRun: number;
  llmModel: string | null;
  reasoningMode: 'off' | 'shadow' | 'active';
  associationMinCooccurrence: number;
  associationMinG2: number;
  associationTopK: number;
  associationMaxDocFraction: number;
  ruleMaxDerivationsPerRun: number;
  ruleMinConfidence: number;
  patternMinPrecision: number;
  patternMinSupport: number;
  patternSourcesPerRun: number;
  searchIndexEnabled: boolean;
  searchIndexBatch: number;
  searchRanker: 'bm25' | 'engine';
  searchWeights: Record<string, number>;
}
