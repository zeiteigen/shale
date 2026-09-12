import { basename } from "node:path";
import { statSync, readFileSync } from "node:fs";
import { sdkStorage, logger, type ShaleSDK } from "@shale/sdk";
import { parseNoteContent, type ParsedNote } from "./parser";
import { dynamicChunkNote, type MarkdownChunk } from "./chunker";

export interface ContextualChunk {
  chunk_index: number;
  text_content: string;
}

export interface ParsedFile {
  filePath: string;
  noteTitle: string;
  noteUri: string;
  updatedAt: number;
  parsed: ParsedNote;
  chunks: MarkdownChunk[];
  contextualChunks: ContextualChunk[];
}

export interface ParseFileOptions {
  expandAtomicNotes?: boolean;
  atomicNoteWordThreshold?: number;
  atomicNoteCharThreshold?: number;
  targetTokens?: number;
  timeoutMs?: number;
}

/**
 * Counts the number of words in a text string.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

/**
 * Calculates dynamic target token count for note expansion based on current note size.
 */
export function calculateDynamicTargetTokens(content: string): number {
  const words = countWords(content);
  // Dynamic scaling: base token allowance plus scaling proportional to content length
  const target = Math.round(150 + words * 1.5);
  return Math.max(100, Math.min(500, target));
}

/**
 * Expands note content using the Chat model to enrich conceptual context,
 * background information, and domain terminology for semantic search.
 */
export async function expandNoteWithChatModel(
  sdk: ShaleSDK,
  noteTitle: string,
  content: string,
  timeoutMs?: number,
  customTargetTokens?: number,
  filePath?: string,
): Promise<string> {
  // Check if a checkpoint already exists for this note summary
  const checkpointKey = filePath
    ? `ai_summary:${filePath}`
    : `ai_summary:${noteTitle}`;

  try {
    const existing = sdk?.checkpoint?.get?.(checkpointKey);
    if (existing?.data?.summary) {
      (sdk?.logger ?? logger).log(
        `Reusing checkpointed AI summary for note "${noteTitle}"`,
      );
      return existing.data.summary;
    }
  } catch {}

  const targetTokens =
    customTargetTokens ?? calculateDynamicTargetTokens(content);

  const prompt = `Expand the following note for semantic retrieval. Provide key concepts, hardware/compiler flows, bit-level arithmetic, and related architectural domains. 

Format requirements:
- Structure as dense, telegraphic bullet points or semicolon-separated technical keywords.
- Omit conversational prose, full sentence syntax, and filler articles (e.g., use "GGUF parser; bitstream generation" rather than complete sentences).
- Target maximum output length: ~${targetTokens} tokens. Do not count.
Note Title: ${noteTitle}
Note Content:
${content}`;

  const system = `You are an expert knowledge assistant specializing in conceptual elaboration and semantic enrichment for personal knowledge bases. Target approximately ${targetTokens} tokens for your expansion response based on the note's size.`;

  try {
    const res = await sdk.queryLLM(
      {
        prompt,
        system,
      },
      timeoutMs !== undefined ? { timeoutMs } : undefined,
    );
    const summary = res.trim();
    if (summary && sdk?.saveCheckpoint) {
      try {
        sdk.saveCheckpoint(
          {
            type: "ai_summary",
            noteTitle,
            filePath,
            summary,
            createdAt: Date.now(),
          },
          { id: checkpointKey, key: checkpointKey },
        );
      } catch (cpErr) {
        (sdk?.logger ?? logger).warn(
          `Failed to save checkpoint for note "${noteTitle}":`,
          cpErr,
        );
      }
    }
    return summary;
  } catch (err) {
    (sdk?.logger ?? logger).warn(
      `Failed to expand note "${noteTitle}" with Chat model:`,
      err,
    );
    return "";
  }
}

/**
 * Builds contextualized chunks by prepending note title, heading hierarchy, and frontmatter metadata.
 */
export function buildContextualChunks(
  chunks: MarkdownChunk[],
  noteTitle: string,
  parsed: ParsedNote,
): ContextualChunk[] {
  // Extract category & subject for domain context
  const categoryStr = Array.isArray(parsed.frontmatter.category)
    ? parsed.frontmatter.category.join(", ")
    : (parsed.frontmatter.category as string) ||
      (parsed.tags.length > 0 ? parsed.tags[0] : "");

  const categoryLine = categoryStr ? `Category: ${categoryStr}\n` : "";
  const tagList = Array.from(
    new Set([
      ...parsed.tags,
      ...(Array.isArray(parsed.frontmatter.category)
        ? (parsed.frontmatter.category as string[])
        : parsed.frontmatter.category
          ? [String(parsed.frontmatter.category)]
          : []),
      ...(Array.isArray(parsed.frontmatter.subject)
        ? (parsed.frontmatter.subject as string[])
        : parsed.frontmatter.subject
          ? [String(parsed.frontmatter.subject)]
          : []),
    ]),
  ).filter(Boolean);
  const tagsLine = tagList.length > 0 ? `Tags: ${tagList.join(", ")}\n` : "";

  if (chunks.length === 0) {
    const contextualText =
      `# Note: ${noteTitle}\n${categoryLine}${tagsLine}`.trim();
    return [
      {
        chunk_index: 0,
        text_content: contextualText || `# Note: ${noteTitle}`,
      },
    ];
  }

  return chunks.map((c) => {
    const headingPart =
      c.heading && c.heading !== noteTitle
        ? ` > ${c.heading.replace(/^#+\s*/, "")}`
        : "";
    const contextualText = `# Note: ${noteTitle}${headingPart}\n${categoryLine}${tagsLine}\n${c.text_content}`;
    return {
      chunk_index: c.chunk_index,
      text_content: contextualText,
    };
  });
}

/**
 * Parses an individual markdown file: reads content, parses frontmatter and wikilinks,
 * performs dynamic chunking, optionally expands atomic notes via Chat model,
 * and contextualizes chunks with metadata.
 *
 * NOTE: Embedding is strictly moved outside this function to support local embedding workloads.
 */
export async function parseFile(
  filePath: string,
  sdkOverride?: ShaleSDK,
  options?: ParseFileOptions,
): Promise<ParsedFile> {
  const rawContent = readFileSync(filePath, "utf-8");
  const filename = basename(filePath);
  const noteTitle = filename.replace(/\.md$/i, "");
  const noteUri = `file://${filePath}`;
  const updatedAt = Math.floor(statSync(filePath).mtimeMs);

  const parsed = parseNoteContent(rawContent, noteTitle);
  const chunks = dynamicChunkNote(parsed.body, noteTitle);

  // Content expansion using Chat model: only short notes (under 250 words) get expanded
  const shouldExpand = options?.expandAtomicNotes ?? true;
  const wordCount = countWords(parsed.body);
  const wordThreshold = options?.atomicNoteWordThreshold ?? 250;
  const timeoutMs = options?.timeoutMs;

  const sdk = sdkOverride ?? sdkStorage.getStore();

  const isShortNote =
    wordCount > 0 &&
    wordCount < wordThreshold &&
    (options?.atomicNoteCharThreshold !== undefined
      ? parsed.body.trim().length < options.atomicNoteCharThreshold
      : true);

  if (shouldExpand && sdk && isShortNote) {
    const expanded = await expandNoteWithChatModel(
      sdk,
      noteTitle,
      parsed.body,
      timeoutMs,
      options?.targetTokens,
      filePath,
    );
    if (expanded) {
      chunks.push({
        heading: `${noteTitle} (Expanded Context)`,
        level: 1,
        chunk_index: chunks.length,
        text_content: expanded,
      });
    }
  }

  const contextualChunks = buildContextualChunks(chunks, noteTitle, parsed);

  return {
    filePath,
    noteTitle,
    noteUri,
    updatedAt,
    parsed,
    chunks,
    contextualChunks,
  };
}

export default parseFile;
