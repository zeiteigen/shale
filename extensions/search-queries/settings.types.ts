import type { Engine } from "./contract";

export interface SearchQueriesSettings {
  /** Engines the Chrome module captures and the server accepts. */
  engines?: Engine[];
  /** Keep Google's AI Overview as snippets. */
  captureAiOverview?: boolean;
  /** Quiet time before a search's source is (re)written. */
  settleMinutes?: number;
  /** Searches indexed per cron run. */
  maxQueriesPerRun?: number;
  namespace?: string;
}

export const SEARCH_QUERIES_DEFAULTS = {
  engines: ["google", "bing", "duckduckgo"] as Engine[],
  captureAiOverview: true,
  settleMinutes: 5,
  maxQueriesPerRun: 200,
  namespace: "search-queries",
};
