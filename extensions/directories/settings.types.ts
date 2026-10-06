export interface DirectorySettings {
  directories?: string[];
  recursive?: boolean;
  ignoreHidden?: boolean;
  ignoredDirectories?: string[];
  fileExtensions?: string[];
  maxFileSizeMB?: number;
  processingTimeoutMs?: number;
  embeddingBatchSize?: number;
  forceAll?: boolean;
  namespace?: string;
}

export const DEFAULT_FILE_EXTENSIONS = [
  "pdf", "docx", "pptx", "xlsx", "odt", "odp", "ods", "rtf",
  "txt", "csv", "md", "html", "epub",
  "png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "tiff",
];
