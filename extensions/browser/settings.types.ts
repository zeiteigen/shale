export interface BrowserExtensionSettings {
  allowPublicPageEnrichment?: boolean;
  maxPublicPagesPerRun?: number;
  enableImageAnalysis: boolean;
  refineResearchContexts: boolean;
  retainRemovedCatalogEvidence: boolean;
  maxPendingJobs: number;
  maxPendingBytes: number;
  maxJobsPerRun: number;
  maxBatchBytes: number;
  maxJobAttempts: number;
  maxSessionsPerRun: number;
  maxSessionEvents: number;
  collectionWindowMs: number;
  maxEmbeddingTexts: number;

  /**
   * List of domain names or hostnames to exclude from ingestion (e.g. social media, messaging).
   */
  excludeDomains: string[];

  /**
   * List of wildcard or regex patterns to exclude from ingestion for privacy or collision prevention.
   */
  excludePatterns: string[];

  /**
   * Whether to exclude private/incognito browsing activity.
   */
  excludePrivateBrowsing: boolean;

  /**
   * Inactivity threshold in minutes after which subsequent web activity is grouped into a new session.
   */
  sessionInactivityMinutes: number;

  /**
   * Whether to invoke LLM to generate summaries, topics, and classifications.
   */
  enableLlmAnalysis: boolean;

  /**
   * Whether to synthesize browsing sessions into a narrative summary using the LLM.
   */
  generateSessionSummaries: boolean;

  /**
   * Whether to extract conceptual topic entities to link in the knowledge graph.
   */
  extractTopics: boolean;

  /**
   * Minimum content character length required for a page to undergo LLM analysis.
   */
  minContentLength: number;

  /**
   * Maximum characters of content sent to the LLM for page or session analysis.
   */
  maxContentChars: number;

  /**
   * Target character chunk size for text indexing and embeddings.
   */
  chunkSize: number;

  /**
   * Custom chat model override for LLM analysis (defaults to OPENAI_CHAT_MODEL).
   */
  llmModel: string | null;

  /**
   * Knowledge graph namespace for browser entities and edges.
   */
  namespace: string;
}
