import { basename } from "node:path";
import { statSync, readFileSync } from "node:fs";
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
 * performs dynamic chunking, and contextualizes chunks with metadata.
 */
export async function parseFile(filePath: string): Promise<ParsedFile> {
  const rawContent = readFileSync(filePath, "utf-8");
  const filename = basename(filePath);
  const noteTitle = filename.replace(/\.md$/i, "");
  const noteUri = `file://${filePath}`;
  const updatedAt = Math.floor(statSync(filePath).mtimeMs);

  const parsed = parseNoteContent(rawContent, noteTitle);
  const chunks = dynamicChunkNote(parsed.body, noteTitle);
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
