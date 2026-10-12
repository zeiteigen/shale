export interface AccessClassifierSettings {
  /** Classify new and changed records into sensitivity tiers. */
  enabled: boolean;
  /** Refine heuristic tiers with the chat model. */
  llmEnabled: boolean;
  /** Maximum sources (with their entities and claims) sent to the model per run. */
  maxSourcesPerRun: number;
  /** Maximum source characters shown to the model per source. */
  maxContentChars: number;
  /** Optional chat model override. */
  llmModel: string | null;
}
