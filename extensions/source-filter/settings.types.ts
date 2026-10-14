export interface SourceFilterSettings {
  enabled: boolean;
  dryRun: boolean;
  llmEnabled: boolean;
  maxSourcesPerRun: number;
  maxLLMCallsPerRun: number;
  maxContentChars: number;
  runBudgetSeconds: number;
  removeConfidence: number;
  llmModel: string | null;
  origins: string[];
  protectedSourceIds: string[];
  protectedUriPatterns: string[];
}

export const SOURCE_FILTER_DEFAULTS: SourceFilterSettings = {
  enabled: true,
  dryRun: false,
  llmEnabled: true,
  maxSourcesPerRun: 500,
  maxLLMCallsPerRun: 20,
  maxContentChars: 24000,
  runBudgetSeconds: 180,
  removeConfidence: 0.9,
  llmModel: null,
  origins: ["browser", "email", "discord", "instagram", "chatgpt", "claude", "gemini", "search", "youtube"],
  protectedSourceIds: [],
  protectedUriPatterns: [],
};
