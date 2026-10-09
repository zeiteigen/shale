export interface ProcessDocumentSettings {
  supportedExtensions?: string[];
  maxFileSizeMB?: number;
  parserTimeoutMs?: number;
  chunkSize?: number;
  includeNotes?: boolean;
  enablePdfOcr?: boolean;
  ocrLanguage?: string;
  enablePdfVision?: boolean;
  pdfVisionMinConfidence?: number;
  summarizeDocuments?: boolean;
  summaryPrompt?: string;
  summaryMaxChars?: number;
  summaryTimeoutMs?: number;
  defaultEntityType?: string;
  defaultRelation?: string;
}

/** Keep resource limits valid even when settings.json is edited directly. */
export function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}
