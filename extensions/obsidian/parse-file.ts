import { basename } from "node:path";
import { statSync, readFileSync } from "node:fs";
import { sdkStorage, type ShaleSDK } from "@shale/sdk";
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
  atomicNoteCharThreshold?: number;
  timeoutMs?: number;
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
): Promise<string> {
  const prompt = `You are a knowledge synthesis assistant. Expand on the following note content to provide a deeper, more detailed explanation for semantic search and knowledge retrieval.
Elaborate on the key ideas, underlying principles, definitions, context, implications, and related domain concepts, while preserving the original intent and core meaning. Do not use stopwords (like "the," "is," "at," and "on").

Note Title: ${noteTitle}
Note Content:
${content}`;

  const system =
    "You are an expert knowledge assistant specializing in conceptual elaboration and semantic enrichment for personal knowledge bases.";

  try {
    const res = await sdk.queryLLM(
      {
        prompt,
        system,
      },
      timeoutMs !== undefined ? { timeoutMs } : undefined,
    );
    return (typeof res === "string" ? res : res?.content || "").trim();
  } catch (err) {
    console.warn(
      `[Obsidian] Failed to expand note "${noteTitle}" with Chat model:`,
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

  // Content expansion using Chat model (Requirement 3: especially targeted toward atomic notes)
  const shouldExpand = options?.expandAtomicNotes ?? true;
  const threshold = options?.atomicNoteCharThreshold ?? 800;
  const timeoutMs = options?.timeoutMs;

  const sdk = sdkOverride ?? sdkStorage.getStore();

  if (
    shouldExpand &&
    sdk &&
    parsed.body.trim().length > 0 &&
    parsed.body.trim().length < threshold
  ) {
    const expanded = await expandNoteWithChatModel(
      sdk,
      noteTitle,
      parsed.body,
      timeoutMs,
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
