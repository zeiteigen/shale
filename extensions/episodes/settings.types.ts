export interface EpisodesSettings {
  enabled: boolean;
  maxSourcesPerRun: number;
  attachScore: number;
  reviewScore: number;
  recencyDays: number;
  maxAdjudicationsPerRun: number;
  dormantDays: number;
  clusteringMode: 'off' | 'shadow' | 'active';
  narrativeMode: 'off' | 'shadow' | 'active';
  llmNarrativePolish: boolean;
  clusterResolution: number;
  clusterTauDays: number;
  clusterHysteresis: number;
  clusterMergeAffinity: number;
  maxClusterChangesPerRun: number;
  llmModel: string | null;
}
