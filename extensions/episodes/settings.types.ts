export interface EpisodesSettings {
  enabled: boolean;
  maxSourcesPerRun: number;
  attachScore: number;
  reviewScore: number;
  recencyDays: number;
  maxAdjudicationsPerRun: number;
  dormantDays: number;
  llmModel: string | null;
}
