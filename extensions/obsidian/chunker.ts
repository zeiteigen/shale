export interface MarkdownChunk {
  heading: string;
  level: number;
  chunk_index: number;
  text_content: string;
}

/**
 * Splits text into paragraph-aware snippets of roughly maxChars.
 */
function splitIntoSnippets(text: string, maxChars: number = 1200): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const paragraphs = text.split(/\n\n+/);
  const snippets: string[] = [];
  let current = "";

  for (const p of paragraphs) {
    if ((current + "\n\n" + p).length > maxChars && current.length > 0) {
      snippets.push(current.trim());
      current = p;
    } else {
      current = current ? current + "\n\n" + p : p;
    }
  }

  if (current.trim()) {
    snippets.push(current.trim());
  }

  return snippets;
}

/**
 * Splits markdown text by a specific heading regex.
 * Consolidates empty heading-only lines into subsequent sections to prevent bare orphan chunks.
 */
function splitByHeadingRegex(
  text: string,
  regex: RegExp,
  level: number,
  fallbackHeading: string,
): Array<{ heading: string; text: string; level: number }> {
  const lines = text.split("\n");
  const rawSections: Array<{ heading: string; text: string; level: number }> =
    [];
  let currentHeading = fallbackHeading;
  let currentLines: string[] = [];

  for (const line of lines) {
    if (regex.test(line)) {
      if (currentLines.length > 0) {
        const body = currentLines.join("\n").trim();
        if (body) {
          rawSections.push({ heading: currentHeading, text: body, level });
        }
      }
      currentHeading = line.trim();
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    const body = currentLines.join("\n").trim();
    if (body) {
      rawSections.push({ heading: currentHeading, text: body, level });
    }
  }

  // Consolidate empty heading-only sections (e.g. "## Key Symbols" immediately followed by "### Light and Fire")
  const sections: Array<{ heading: string; text: string; level: number }> = [];
  let pendingPrefix = "";

  for (let i = 0; i < rawSections.length; i++) {
    const sec = rawSections[i];
    const bodyWithoutHeading = sec.text.replace(regex, "").trim();

    if (bodyWithoutHeading.length === 0 && i + 1 < rawSections.length) {
      pendingPrefix = pendingPrefix
        ? `${pendingPrefix} > ${sec.heading}`
        : sec.heading;
    } else {
      if (pendingPrefix) {
        sec.heading = `${pendingPrefix} > ${sec.heading}`;
        sec.text = `${pendingPrefix}\n\n${sec.text}`;
        pendingPrefix = "";
      }
      sections.push(sec);
    }
  }

  if (pendingPrefix && sections.length > 0) {
    sections[sections.length - 1].text += `\n\n${pendingPrefix}`;
  }

  return sections.length > 0
    ? sections
    : [{ heading: fallbackHeading, text, level }];
}

/**
 * Dynamically chunks a markdown note based on length and heading hierarchy:
 * - Empty notes (0 chars): Empty chunk list.
 * - Atomic notes (< 600 chars): Chunked as a single item.
 * - Moderate notes (600 - 2500 chars): Chunked by H1 (or H2 if no H1) or paragraph snippets.
 * - Large notes (> 2500 chars): Chunked by H2, sub-chunked by H3 and paragraph snippets.
 *
 * @param content Note text content (without frontmatter)
 * @param noteTitle Title of the note
 */
export function dynamicChunkNote(
  content: string,
  noteTitle: string,
): MarkdownChunk[] {
  const trimmed = content.trim();
  const len = trimmed.length;

  // 0. Empty Note
  if (len === 0) {
    return [];
  }

  // Whole note representation (Chunk 0)
  const wholeNoteChunk: MarkdownChunk = {
    heading: noteTitle,
    level: 0,
    chunk_index: 0,
    text_content: trimmed,
  };

  // 1. Atomic Notes (< 600 chars)
  if (len < 600) {
    return [wholeNoteChunk];
  }

  // 2. Moderate Length Notes (600 - 2500 chars)
  if (len <= 2500) {
    const hasH1 = /^#\s+/m.test(trimmed);
    const hasH2 = /^##\s+/m.test(trimmed);

    if (hasH1) {
      const sections = splitByHeadingRegex(trimmed, /^#\s+/, 1, noteTitle);
      const sectionChunks = sections.map((s, idx) => ({
        heading: s.heading,
        level: 1,
        chunk_index: idx + 1,
        text_content: s.text,
      }));
      return [wholeNoteChunk, ...sectionChunks];
    } else if (hasH2) {
      const sections = splitByHeadingRegex(trimmed, /^##\s+/, 2, noteTitle);
      const sectionChunks = sections.map((s, idx) => ({
        heading: s.heading,
        level: 2,
        chunk_index: idx + 1,
        text_content: s.text,
      }));
      return [wholeNoteChunk, ...sectionChunks];
    } else {
      const snippets = splitIntoSnippets(trimmed, 900);
      const snippetChunks = snippets.map((snip, idx) => ({
        heading: `${noteTitle} (Section ${idx + 1})`,
        level: 0,
        chunk_index: idx + 1,
        text_content: snip,
      }));
      return [wholeNoteChunk, ...snippetChunks];
    }
  }

  // 3. Large Notes (> 2500 chars)
  // Primary split by H2, fallback to H1
  const hasH2 = /^##\s+/m.test(trimmed);
  const hasH1 = /^#\s+/m.test(trimmed);

  const topSections = hasH2
    ? splitByHeadingRegex(trimmed, /^##\s+/, 2, noteTitle)
    : hasH1
      ? splitByHeadingRegex(trimmed, /^#\s+/, 1, noteTitle)
      : [{ heading: noteTitle, text: trimmed, level: 0 }];

  const chunks: MarkdownChunk[] = [wholeNoteChunk];
  let chunkIndex = 1;

  for (const sec of topSections) {
    // If section is long and contains H3 headings, subdivide by H3
    if (sec.text.length > 1800 && /^###\s+/m.test(sec.text)) {
      const subSections = splitByHeadingRegex(
        sec.text,
        /^###\s+/,
        3,
        sec.heading,
      );
      for (const sub of subSections) {
        if (sub.text.length > 1500) {
          const snippets = splitIntoSnippets(sub.text, 1200);
          for (const snip of snippets) {
            chunks.push({
              heading: sub.heading,
              level: 3,
              chunk_index: chunkIndex++,
              text_content: snip,
            });
          }
        } else {
          chunks.push({
            heading: sub.heading,
            level: 3,
            chunk_index: chunkIndex++,
            text_content: sub.text,
          });
        }
      }
    } else if (sec.text.length > 1500) {
      // Subdivide long section by snippets
      const snippets = splitIntoSnippets(sec.text, 1200);
      for (const snip of snippets) {
        chunks.push({
          heading: sec.heading,
          level: sec.level,
          chunk_index: chunkIndex++,
          text_content: snip,
        });
      }
    } else {
      chunks.push({
        heading: sec.heading,
        level: sec.level,
        chunk_index: chunkIndex++,
        text_content: sec.text,
      });
    }
  }

  return chunks;
}

export default dynamicChunkNote;
