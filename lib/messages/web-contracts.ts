import type { ProcessedChunk } from './contracts';
import type { PreparedSourceClaim } from '../../sdk/graph/prepared';

export interface WebPageParseRequest {
  url: string;
  title?: string;
  textContent?: string;
  html?: string;
  imageUrls?: string[];
  chunkSize?: number;
  includeImages?: boolean;
}
export interface WebPageParseResponse {
  title: string;
  text: string;
  chunks: string[];
  contextualSummary: string;
  contextMethod?: string;
  contextModel?: string;
  imageUrls: string[];
  imageChunks: Array<Pick<ProcessedChunk,'text_content'|'chunk_type'|'metadata'>>;
  /** Interpretation evidence indexes refer to imageChunks, not page text chunks. */
  imageKnowledge?: Array<{uri:string;title:string;claims:PreparedSourceClaim[]}>;
}
export interface WebChannelDefinitions {
  'web:parse': { type:'request';request:WebPageParseRequest;response:WebPageParseResponse };
}
