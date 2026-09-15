/**
 * Type definitions for all configurable parameters in the Obsidian extension.
 * These can be configured in settings.json inside the extension directory.
 */
export interface ObsidianSettings {
  /**
   * Optional custom path to obsidian.json (defaults to ~/.config/obsidian/obsidian.json).
   */
  obsidianConfigPath?: string;

  /**
   * Explicit custom vault definitions (paths or objects with name and path) to index.
   */
  customVaults?: Array<{ name?: string; path: string } | string>;

  /**
   * Additional folder names to ignore during note/image scanning (e.g. ["templates", "archive"]).
   * Hidden folders starting with "." (.obsidian, .git, .trash) are always ignored by default.
   */
  ignoredDirectories?: string[];

  /**
   * Whether to discover and process markdown notes (.md).
   * @default true
   */
  includeMarkdown?: boolean;

  /**
   * Whether to discover and process image files.
   * @default true
   */
  includeImages?: boolean;

  /**
   * Recognized image file extensions.
   * @default ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "tiff"]
   */
  imageExtensions?: string[];

  /**
   * Maximum character length for an atomic note (kept as a single whole-note chunk).
   * @default 600
   */
  atomicNoteCharLimit?: number;

  /**
   * Character threshold separating moderate length notes from large notes.
   * @default 2500
   */
  moderateNoteCharLimit?: number;

  /**
   * Max characters per paragraph snippet for moderate notes without headings.
   * @default 900
   */
  moderateSnippetMaxChars?: number;

  /**
   * Max characters per paragraph snippet for large notes.
   * @default 1200
   */
  largeNoteSnippetMaxChars?: number;

  /**
   * Minimum section character length before checking for H3 subdivisions in large notes.
   * @default 1800
   */
  h3SubdivisionMinSectionChars?: number;

  /**
   * Minimum H3 subsection length before paragraph snippet splitting in large notes.
   * @default 1500
   */
  h3SnippetSubdivisionMinChars?: number;

  /**
   * Minimum section length before paragraph snippet splitting in large notes.
   * @default 1500
   */
  largeSectionSnippetMinChars?: number;

  /**
   * Whether to expand atomic/short notes using the Chat model.
   * @default true
   */
  expandAtomicNotes?: boolean;

  /**
   * Word count cutoff below which a note qualifies as short/atomic for expansion.
   * @default 250
   */
  atomicNoteWordThreshold?: number;

  /**
   * Optional character length ceiling for note expansion.
   */
  atomicNoteCharThreshold?: number;

  /**
   * Fixed target token count override for LLM expansion response.
   */
  targetTokens?: number;

  /**
   * Base allowance for dynamic target tokens formula: Math.round(base + words * multiplier).
   * @default 150
   */
  dynamicTokenBase?: number;

  /**
   * Multiplier per word in dynamic target tokens formula.
   * @default 1.5
   */
  dynamicTokenMultiplier?: number;

  /**
   * Minimum allowed tokens in dynamic target tokens clamp.
   * @default 100
   */
  dynamicTokenMin?: number;

  /**
   * Maximum allowed tokens in dynamic target tokens clamp.
   * @default 500
   */
  dynamicTokenMax?: number;

  /**
   * Custom user prompt template for note expansion.
   * Can use {{title}} and {{content}} placeholders.
   */
  chatPromptTemplate?: string;

  /**
   * Custom system prompt for note expansion.
   * Can use {{targetTokens}} placeholder.
   */
  chatSystemPrompt?: string;

  /**
   * Timeout in milliseconds for note expansion LLM queries.
   */
  chatTimeoutMs?: number;

  /**
   * Whether to generate multimodal text descriptions for images using the Chat model.
   * @default true
   */
  describeImages?: boolean;

  /**
   * Custom prompt for multimodal image descriptions.
   */
  imagePrompt?: string;

  /**
   * Custom system prompt for multimodal image descriptions.
   */
  imageSystemPrompt?: string;

  /**
   * Timeout in milliseconds for image description LLM queries.
   */
  imageTimeoutMs?: number;

  /**
   * Fallback text template when image description fails or runs offline.
   * Can use {{imageName}} placeholder.
   */
  fallbackDescriptionTemplate?: string;

  /**
   * Number of prior chunks to hydrate for continuity context during file ingestion.
   * @default 3
   */
  contextHydrationLimit?: number;

  /**
   * Dimension size of fallback embedding vectors when embedding model is unreachable.
   * @default 4096
   */
  fallbackEmbeddingDimensions?: number;

  /**
   * Namespace for sources, chunks, and graph elements.
   * @default "obsidian"
   */
  namespace?: string;

  /**
   * If true, forces reprocessing of all vault files, ignoring mtime watermarks.
   * @default false
   */
  forceAll?: boolean;
}
