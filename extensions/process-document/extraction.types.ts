import type { DocumentFormat } from "./document-format";

export interface ExtractionRequest {
  filePath: string;
  format: DocumentFormat;
  maxFileBytes: number;
  chunkSize: number;
  includeNotes: boolean;
  enablePdfOcr?: boolean;
  ocrLanguage?: string;
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

export type ExtractionReply = { document: ExtractedDocument } | { error: string }
  | { ocrCache: { key: string; pages: number } }
  | { ocrPage: { key: string; page: number; result: OcrPage } };

export interface OcrPage { text: string; confidence: number }

export interface OcrPageStore {
  load(key: string, pages: number): Record<number, OcrPage>;
  save(key: string, page: number, result: OcrPage): void;
}
