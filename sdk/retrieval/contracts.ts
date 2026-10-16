/**
 * Interfaces shared by the search-engine stages (see docs: index → query understanding → candidates → ranking).
 * Modules: lib/text/terms.ts (corpus keyphrases + phrase dictionary), sdk/retrieval/indexer.ts (fielded index),
 * sdk/retrieval/query.ts (query understanding), sdk/retrieval/engine.ts (candidates, features, ranking, collapsing).
 */

/** Fields of `source_search_fts`, in column order; bm25() weights follow the same order. */
export const SEARCH_FIELDS = ['title', 'entities', 'keyphrases', 'summary', 'body'] as const;
export type SearchField = typeof SEARCH_FIELDS[number];
export const DEFAULT_FIELD_WEIGHTS: Record<SearchField, number> = { title: 4, entities: 3, keyphrases: 2.5, summary: 1.5, body: 1 };

/** Corpus phrase statistics (lib/text/terms.ts). Keys are lower-cased, space-joined word tokens. */
export interface PhraseDictionary {
  /** Number of documents the dictionary was built from. */
  documents: number;
  has(phrase: string): boolean;
  /** Document frequency, C-value, and collocation strength, or undefined for an unknown phrase. */
  get(phrase: string): { df: number; cValue: number; g2: number } | undefined;
}

export interface Keyphrase { phrase: string; score: number }

export type QueryIntent = 'navigational' | 'informational' | 'temporal';

/** Output of sdk/retrieval/query.ts parseQuery(). */
export interface ParsedQuery {
  raw: string;
  /** Content terms after normalisation, with IDF weight; optional terms (very common) do not count toward coverage. */
  terms: Array<{ text: string; weight: number; optional: boolean; corrected?: string }>;
  /** Quoted phrases and dictionary-detected multiword phrases. */
  phrases: Array<{ text: string; quoted: boolean }>;
  /** Canonical entities linked from the query (gazetteer, acronym/search-key expansion). */
  entities: Array<{ id: number; name: string; surface: string; weight: number; expansions?: string[] }>;
  /** before/after are epoch ms from explicit operators (a hard date filter; relative wording only narrows when it matches). */
  filters: { from?: string; origin?: string; type?: string; sourceId?: string; before?: number; after?: number };
  /** Inclusive epoch-ms range from explicit operators or temporal expressions. */
  dateRange?: { start?: number; end?: number };
  /** Deadline/upcoming wording: prefer future-dated sources. */
  future?: boolean;
  intent: QueryIntent;
}

/** One ranked source from sdk/retrieval/engine.ts. */
export interface RankedSource {
  sourceId: string;
  score: number;
  /** Best passage for the snippet. */
  chunkIndex: number;
  /** Collapsed near-duplicates/template siblings/thread siblings represented by this hit. */
  similar: string[];
  matched: { fields: SearchField[]; entities: number[]; terms: string[] };
  /** Feature contributions, only when explain is requested. */
  explain?: Record<string, number>;
}
