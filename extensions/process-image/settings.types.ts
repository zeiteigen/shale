export interface ProcessImageSettings {
  describeImages?: boolean;
  imagePrompt?: string;
  imageSystemPrompt?: string;
  imageTimeoutMs?: number;
  fallbackDescriptionTemplate?: string;
  supportedExtensions?: string[];
  defaultRelation?: string;
  defaultEntityType?: string;
}
