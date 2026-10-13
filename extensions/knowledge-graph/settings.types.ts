export interface KnowledgeGraphSettings {
  resolverEnabled: boolean;
  selfNames: string[];
  selfEmails: string[];
  selfHandles: string[];
  maxAdjudicationsPerRun: number;
  llmModel: string | null;
}
