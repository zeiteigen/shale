import { basename, resolve } from "node:path";
import { statSync, readFileSync } from "node:fs";
import { sdkStorage, logger, getSetting, type ShaleSDK } from "@shale/sdk";
import type { ChunkType } from "../../lib/db";
import { parseNoteContent, type ParsedNote } from "./parser";
import { dynamicChunkNote, type MarkdownChunk } from "./chunker";
import { expansionPrompt } from "./expansion-prompt";

export interface ContextualChunk {
  metadata?: Record<string, unknown>;
  chunk_index: number;
  chunk_type?: ChunkType;
  text_content: string;
}

export interface ParsedFile {
  filePath: string;
  noteTitle: string;
  noteUri: string;
  updatedAt: number;
  parsed: ParsedNote;
  linkTargets?: Record<string,string>;
  assetTargets?: Record<string,string>;
  documentTargets?: Record<string,string>;
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
 * Calculates dynamic target token count for note expansion based on current note size and settings.
 */
export function calculateDynamicTargetTokens(
  content: string,
  sdk?: ShaleSDK,
): number {
  const words = countWords(content);
  const base =
    sdk?.settings.get<number>("dynamicTokenBase") ??
    getSetting<number>("dynamicTokenBase", 150);
  const multiplier =
    sdk?.settings.get<number>("dynamicTokenMultiplier") ??
    getSetting<number>("dynamicTokenMultiplier", 1.5);
  const minTokens =
    sdk?.settings.get<number>("dynamicTokenMin") ??
    getSetting<number>("dynamicTokenMin", 100);
  const maxTokens =
    sdk?.settings.get<number>("dynamicTokenMax") ??
    getSetting<number>("dynamicTokenMax", 500);

  // Dynamic scaling: base token allowance plus scaling proportional to content length
  const target = Math.round(base + words * multiplier);
  return Math.max(minTokens, Math.min(maxTokens, target));
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
    customTargetTokens ??
    sdk?.settings.get<number>("targetTokens") ??
    getSetting<number>("targetTokens") ??
    calculateDynamicTargetTokens(content, sdk);

  const configuredPromptTemplate =
    sdk?.settings.get<string>("chatPromptTemplate") ??
    getSetting<string>("chatPromptTemplate");

  const prompt = configuredPromptTemplate
    ? configuredPromptTemplate
        .replace(/\{\{title\}\}/g, noteTitle)
        .replace(/\{\{content\}\}/g, content)
        .replace(/\{\{targetTokens\}\}/g, String(targetTokens))
    : expansionPrompt(noteTitle, content, targetTokens);

  const configuredSystemPrompt =
    sdk?.settings.get<string>("chatSystemPrompt") ??
    getSetting<string>("chatSystemPrompt");

  const system = configuredSystemPrompt
    ? configuredSystemPrompt.replace(/\{\{targetTokens\}\}/g, String(targetTokens))
    : `You are an expert knowledge assistant specializing in conceptual elaboration and semantic enrichment for personal knowledge bases. Target approximately ${targetTokens} tokens for your expansion response based on the note's size.`;

  const effectiveTimeout =
    timeoutMs !== undefined
      ? timeoutMs
      : sdk?.settings.get<number>("chatTimeoutMs") ??
        getSetting<number>("chatTimeoutMs");

  try {
    const res = await sdk.queryLLM(
      {
        prompt,
        system,
      },
      effectiveTimeout !== undefined ? { timeoutMs: effectiveTimeout } : undefined,
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
        chunk_type: "verbatim",
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
      chunk_type: c.chunk_type ?? "verbatim",
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
  const noteUri = `file://${resolve(filePath)}`;
  const updatedAt = Math.floor(statSync(filePath).mtimeMs);

  const parsed = parseNoteContent(rawContent, noteTitle);
  const chunks = dynamicChunkNote(parsed.body, noteTitle);

  const sdk = sdkOverride ?? sdkStorage.getStore();

  // Content expansion using Chat model: only short notes get expanded
  const shouldExpand =
    options?.expandAtomicNotes ??
    sdk?.settings.get<boolean>("expandAtomicNotes") ??
    getSetting<boolean>("expandAtomicNotes", true);
  const wordCount = countWords(parsed.body);
  const wordThreshold =
    options?.atomicNoteWordThreshold ??
    sdk?.settings.get<number>("atomicNoteWordThreshold") ??
    getSetting<number>("atomicNoteWordThreshold", 250);
  const charThreshold =
    options?.atomicNoteCharThreshold ??
    sdk?.settings.get<number>("atomicNoteCharThreshold") ??
    getSetting<number>("atomicNoteCharThreshold");
  const timeoutMs =
    options?.timeoutMs ??
    sdk?.settings.get<number>("chatTimeoutMs") ??
    getSetting<number>("chatTimeoutMs");
  const targetTokens =
    options?.targetTokens ??
    sdk?.settings.get<number>("targetTokens") ??
    getSetting<number>("targetTokens");

  const isShortNote =
    wordCount > 0 &&
    wordCount < wordThreshold &&
    (charThreshold !== undefined
      ? parsed.body.trim().length < charThreshold
      : true);

  if (shouldExpand && sdk && isShortNote) {
    const expanded = await expandNoteWithChatModel(
      sdk,
      noteTitle,
      parsed.body,
      timeoutMs,
      targetTokens,
      filePath,
    );
    if (expanded) {
      chunks.push({
        heading: `${noteTitle} (Expanded Context)`,
        level: 1,
        chunk_index: chunks.length,
        chunk_type: "synthetic",
        text_content: expanded,
      });
    }
  }

  const contextualChunks = buildContextualChunks(chunks, noteTitle, parsed);
  for (const chunk of contextualChunks) if (chunk.chunk_type === "synthetic")
    chunk.metadata = {origin:"llm",model:sdk?.llm.options?.().model};
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---/.exec(rawContent)?.[0];
  if (frontmatter) contextualChunks.push({chunk_index:contextualChunks.length,
    chunk_type:"verbatim",text_content:frontmatter,metadata:{origin:"frontmatter"}});

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
