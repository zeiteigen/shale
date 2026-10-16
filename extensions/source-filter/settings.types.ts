export interface SourceFilterSettings {
  enabled: boolean;
  dryRun: boolean;
  llmEnabled: boolean;
  maxSourcesPerRun: number;
  maxLLMCallsPerRun: number;
  maxContentChars: number;
  runBudgetSeconds: number;
  removeConfidence: number;
  /** Route a source to review when this many other sources from the same origin and producer are near-identical (0 disables). */
  nearDuplicateMinCopies: number;
  /** Maximum SimHash Hamming distance (bits of 64) counted as near-identical. */
  nearDuplicateDistance: number;
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
  nearDuplicateMinCopies: 3,
  nearDuplicateDistance: 3,
  llmModel: null,
  origins: ["browser", "email", "discord", "instagram", "chatgpt", "claude", "gemini", "search", "youtube"],
  protectedSourceIds: [],
  protectedUriPatterns: [],
};
