export interface WebPageParseRequest {
  url: string;
  title?: string;
  /** Browser-extracted visible text; HTML is fetched only when this is absent. */
  textContent?: string;
  html?: string;
  /** Image URLs already resolved by the live DOM (including lazy-loaded images). */
  imageUrls?: string[];
  chunkSize?: number;
  includeImages?: boolean;
}

export interface WebPageParseResponse {
  title: string;
  text: string;
  chunks: string[];
  contextualSummary: string;
  imageUrls: string[];
  imageChunks: Array<{
    text_content: string;
    chunk_type: "verbatim" | "synthetic";
  }>;
}
