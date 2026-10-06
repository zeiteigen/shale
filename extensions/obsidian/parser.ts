import { parseDocumentReferences, type DocumentReference } from "./document-references";
import { isDocumentFile } from "./document-files";

export interface ParsedNote {
  title: string;
  body: string;
  rawContent: string;
  wikilinks: string[];
  references?: Array<{target:string;raw:string;alias?:string;heading?:string;position:number}>;
  images: string[];
  documents?: DocumentReference[];
  tags: string[];
  frontmatter: Record<string, unknown>;
}

import { getSetting } from "@shale/sdk";

export const DEFAULT_IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "svg",
  "bmp",
  "tiff",
]);

export const IMAGE_EXTENSIONS = DEFAULT_IMAGE_EXTENSIONS;

/**
 * Resolves the active set of image extensions, preferring settings.json if configured.
 */
export function getImageExtensions(
  customExtensions?: string[] | Set<string>,
): Set<string> {
  if (customExtensions) {
    return customExtensions instanceof Set
      ? customExtensions
      : new Set(customExtensions.map((e) => e.toLowerCase().replace(/^\./, "")));
  }

  const configured = getSetting<string[]>("imageExtensions");
  if (Array.isArray(configured) && configured.length > 0) {
    return new Set(
      configured.map((e) => e.toLowerCase().replace(/^\./, "")),
    );
  }

  return DEFAULT_IMAGE_EXTENSIONS;
}

/**
 * Checks whether a filename or path represents an image.
 */
export function isImageFile(
  filepath: string,
  customExtensions?: string[] | Set<string>,
): boolean {
  const ext = filepath.split(".").pop()?.toLowerCase();
  if (!ext) return false;
  const active = getImageExtensions(customExtensions);
  return active.has(ext);
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

    try {
      const properties = Bun.YAML.parse(yamlText);
      if (properties && typeof properties === "object" && !Array.isArray(properties)) {
        Object.assign(frontmatter, JSON.parse(JSON.stringify(properties)));
        for (const key of ["tags", "tag", "category"]) {
          const value = frontmatter[key];
          if (Array.isArray(value)) tags.push(...value.filter((item): item is string => typeof item === "string"));
          else if (typeof value === "string") tags.push(...value.split(/[,\s]+/).filter(Boolean));
        }
      }
    } catch {
      // Invalid YAML remains in rawContent; do not invent parsed properties.
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
  const references: NonNullable<ParsedNote['references']> = [];
  const linkRegex = /\[\[(.*?)\]\]/g;
  while ((match = linkRegex.exec(textWithoutEmbeds)) !== null) {
    const target = normalizeWikilink(match[1]);
    if (target && target !== defaultTitle && !isDocumentFile(target)) {
      wikilinks.add(target);
      const [destination,alias] = match[1].split('|');
      references.push({target,raw:match[0],alias,heading:destination.split('#').slice(1).join('#') || undefined,
        position:references.length});
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
    references,
    images: Array.from(images),
    documents: parseDocumentReferences(body),
    tags: Array.from(new Set(tags)),
    frontmatter,
  };
}

export default parseNoteContent;
