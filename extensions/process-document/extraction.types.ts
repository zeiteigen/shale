import type { DocumentFormat } from "./document-format";

export interface ExtractionRequest {
  filePath: string;
  format: DocumentFormat;
  maxFileBytes: number;
  chunkSize: number;
  includeNotes: boolean;
}

export interface ExtractedDocument {
  format: DocumentFormat;
  text: string;
  chunks: Array<{ text: string; metadata: Record<string, unknown> }>;
  updatedAt: number;
  assetHash: string;
  metadata: Record<string, unknown>;
  warnings: string[];
}

export type ExtractionReply = { document: ExtractedDocument } | { error: string };
