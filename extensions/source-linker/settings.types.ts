export interface SourceLinkerSettings {
  knnK: number;
  minKnnSimilarity: number;
  maxPairsPerRun: number;
  bidirectional: boolean;
  defaultRelation: string;
  minLlmConfidence: number;
  contextChunksPerSource: number;
  maxContentChars: number;
  llmModel: string | null;
  chatPromptTemplate: string | null;
  forceAll: boolean;
  namespace: string;
  enableEntityResolution: boolean;
  minEntityConfidence: number;
  maxEntityResolutionsPerPair: number;
}

export default SourceLinkerSettings;
