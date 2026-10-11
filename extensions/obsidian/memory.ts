import { memoryChunks, prepareSourceMemory, type PreparedSourceMemory } from "../../lib/memory/prepare";
import type { ParsedFile } from "./parse-file";
import type { ParsedImage } from "./parse-image";
import type { ParsedDocument } from "./parse-document";

function compactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length <= 1000 ? value : `${value.slice(0, 1000)}…`;
  if (Array.isArray(value)) return value.slice(0, 64).map(item => compactValue(item, depth + 1));
  if (value && typeof value === "object" && depth < 6) return Object.fromEntries(
    Object.entries(value).slice(0, 64).map(([key, item]) => [key, compactValue(item, depth + 1)]));
  return value;
}

export function compactParsedFile(file: ParsedFile): ParsedFile {
  const memory = file.memory ?? prepareSourceMemory(file.contextualChunks, { title: file.noteTitle });
  return { ...file, parsed: { ...file.parsed, body: "", rawContent: "",
      frontmatter: compactValue(file.parsed.frontmatter) as ParsedFile["parsed"]["frontmatter"] }, chunks: [],
    contextualChunks: memoryChunks(memory), memory };
}

export function compactParsedImage(image: ParsedImage): ParsedImage {
  const memory = image.memory ?? prepareSourceMemory(image.contextualChunks, { title: image.imageTitle, summary: image.description });
  const chunks = memoryChunks(memory);
  return { ...image, description: memory.summary, knowledge: undefined, contextualChunk: chunks[0], contextualChunks: chunks, memory };
}

export function compactParsedDocument(document: ParsedDocument): ParsedDocument {
  const memory = document.memory ?? prepareSourceMemory(document.contextualChunks, { title: document.documentTitle });
  const knowledge = document.knowledge.flatMap(claim => {
    if (claim.predicate === "DOCUMENT_SUMMARY") return [{ ...claim, value: memory.summary }];
    if (claim.chunkIndex === undefined) return [{ ...claim, value: compactValue(claim.value) as typeof claim.value }];
    const snippet = memory.snippets.find(item => item.locator.originalChunkIndex === claim.chunkIndex);
    if (!snippet) return [];
    const value = claim.value && typeof claim.value === "object" && !Array.isArray(claim.value) && "text" in claim.value
      ? { ...claim.value, text: snippet.text } : snippet.text;
    return [{ ...claim, value: compactValue(value) as typeof claim.value }];
  });
  return { ...document, knowledge, contextualChunks: memoryChunks(memory), memory };
}

export function memoryForChunks(chunks: Parameters<typeof prepareSourceMemory>[0], title: string, summary?: string): PreparedSourceMemory {
  return prepareSourceMemory(chunks, { title, summary });
}
