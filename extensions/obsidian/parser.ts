export interface ParsedNote {
  title: string;
  body: string;
  rawContent: string;
  wikilinks: string[];
  images: string[];
  tags: string[];
  frontmatter: Record<string, unknown>;
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "svg",
  "bmp",
  "tiff",
]);

/**
 * Checks whether a filename or path represents an image.
 */
export function isImageFile(filepath: string): boolean {
  const ext = filepath.split(".").pop()?.toLowerCase();
  return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}

/**
 * Normalizes wikilink target by stripping aliases, heading anchors, and .md extensions.
 */
export function normalizeWikilink(rawTarget: string): string {
  // Strip alias: [[Target|Alias]] -> Target
  let cleaned = rawTarget.split("|")[0];
  // Strip anchor: [[Target#Heading]] -> Target
  cleaned = cleaned.split("#")[0].trim();
  // Strip .md extension if present
  if (cleaned.toLowerCase().endsWith(".md")) {
    cleaned = cleaned.slice(0, -3);
  }
  return cleaned.trim();
}

/**
 * Parses markdown note content, extracting frontmatter, wikilinks, and image references.
 */
export function parseNoteContent(
  rawContent: string,
  defaultTitle: string,
): ParsedNote {
  let body = rawContent;
  const frontmatter: Record<string, unknown> = {};
  const tags: string[] = [];

  // 1. Extract and strip YAML frontmatter
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(rawContent);
  if (frontmatterMatch) {
    const yamlText = frontmatterMatch[1];
    body = rawContent.slice(frontmatterMatch[0].length);

    // Line-based YAML parsing for tags, category, and properties
    let currentKey: string | null = null;
    for (const line of yamlText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("- ")) {
        const item = trimmed.slice(2).trim();
        tags.push(item);
        if (currentKey) {
          if (!Array.isArray(frontmatter[currentKey])) {
            frontmatter[currentKey] = [];
          }
          (frontmatter[currentKey] as string[]).push(item);
        }
      } else if (trimmed.includes(":")) {
        const [k, ...v] = trimmed.split(":");
        const key = k.trim();
        const val = v.join(":").trim();
        if (val) {
          frontmatter[key] = val;
          currentKey = null;
          if (
            key.toLowerCase() === "tags" ||
            key.toLowerCase() === "tag" ||
            key.toLowerCase() === "category"
          ) {
            tags.push(val);
          }
        } else {
          frontmatter[key] = [];
          currentKey = key;
        }
      }
    }
  }

  // 2. Extract embedded images: ![[Image.png|alt]] and standard markdown: ![alt](image.png)
  const images = new Set<string>();

  const embedRegex = /!\[\[(.*?)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = embedRegex.exec(body)) !== null) {
    const rawTarget = match[1].split("|")[0].trim();
    if (isImageFile(rawTarget)) {
      images.add(rawTarget);
    }
  }

  const mdImageRegex = /!\[(.*?)\]\((.*?)\)/g;
  while ((match = mdImageRegex.exec(body)) !== null) {
    const imgUrl = match[2].trim();
    if (
      isImageFile(imgUrl) ||
      imgUrl.startsWith("http://") ||
      imgUrl.startsWith("https://")
    ) {
      images.add(imgUrl);
    }
  }

  // 3. Extract wikilinks: [[Target]]
  // Remove image embeds first to avoid false matches
  const textWithoutEmbeds = body
    .replace(/!\[\[.*?\]\]/g, "")
    .replace(/!\[.*?\]\(.*?\)/g, "");

  const wikilinks = new Set<string>();
  const linkRegex = /\[\[(.*?)\]\]/g;
  while ((match = linkRegex.exec(textWithoutEmbeds)) !== null) {
    const target = normalizeWikilink(match[1]);
    if (target && target !== defaultTitle) {
      wikilinks.add(target);
    }
  }

  // 4. Extract inline hashtags: #tag (not in headings)
  const tagRegex = /(?:^|\s)#([a-zA-Z0-9_\-\/]+)(?=\s|$)/g;
  while ((match = tagRegex.exec(body)) !== null) {
    const tag = match[1];
    // Ignore pure numbers or single chars
    if (tag && !/^\d+$/.test(tag)) {
      tags.push(tag);
    }
  }

  return {
    title: defaultTitle,
    body: body.trim(),
    rawContent,
    wikilinks: Array.from(wikilinks),
    images: Array.from(images),
    tags: Array.from(new Set(tags)),
    frontmatter,
  };
}

export default parseNoteContent;
