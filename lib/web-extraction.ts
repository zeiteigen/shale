import { Readability } from "@mozilla/readability";
import type { PageBlock, ExtractionInfo } from "./browser-contract";

const CLUTTER =
  'script,style,noscript,nav,footer,aside,form,dialog,iframe,svg,[hidden],[aria-hidden="true"],[role="navigation"],.advertisement,.cookie-banner';
const BLOCKS = "h1,h2,h3,h4,h5,h6,p,pre,ul,ol,table,blockquote,figcaption,dd,dt,summary";
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const clean = (text: string) => text.replace(/\s+/g, " ").trim();

/** Candidate selection and structural extraction shared by live DOM and HTML parsing. */
export function extractDocument(
  document: Document,
  baseUrl: string,
  maxChars = 100000,
) {
  const clone = document.cloneNode(true) as Document;
  clone.querySelectorAll(CLUTTER).forEach((node) => node.remove());
  const candidates = [...clone.querySelectorAll('article,main,[role="main"]')];
  const score = (node: Element) =>
    clean(node.textContent ?? "").length -
    2 *
      clean([...node.querySelectorAll("a")].map((x) => x.textContent).join(" "))
        .length +
    100 * node.querySelectorAll("pre,table,h2").length;
  let root =
    candidates.sort((a, b) => score(b) - score(a))[0] ||
    clone.body ||
    clone.documentElement;
  let method = "semantic-root";
  try {
    const article = new Readability(clone.cloneNode(true) as Document, {
      maxElemsToParse: 15000,
      charThreshold: 200,
    }).parse();
    // Documentation structure takes priority over article heuristics.
    if (
      article?.content &&
      !root.querySelector("pre,table") &&
      article.textContent &&
      article.textContent.length >=
        Math.max(200, clean(root.textContent ?? "").length * 0.6)
    ) {
      const div = clone.createElement("article");
      div.innerHTML = article.content;
      root = div;
      method = "readability";
    }
  } catch {
    /* A bounded semantic root also handles malformed/non-article pages. */
  }
  root.querySelectorAll(CLUTTER).forEach((node) => node.remove());
  const elements = [...root.querySelectorAll(BLOCKS)].filter(
    (node) => !node.parentElement?.closest("pre,ul,ol,table,blockquote"),
  );
  if (root.matches(BLOCKS)) elements.unshift(root);
  const blocks: PageBlock[] = [];
  const headings: string[] = [];
  let originalChars = 0,
    truncated = false;
  const started = Date.now();
  for (const [index, node] of elements.entries()) {
    if (index >= 15000 || Date.now() - started > 1500) {
      truncated = true;
      break;
    }
    let kind: PageBlock["kind"] = "paragraph",
      text = "";
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      kind = "heading";
      const level = Number(tag[1]);
      headings.length = level - 1;
      headings[level - 1] = clean(node.textContent || "").slice(0, 500);
    } else if (tag === "pre") kind = "code";
    else if (["ul", "ol"].includes(tag)) kind = "list";
    else if (tag === "table") kind = "table";
    else if (tag === "blockquote") kind = "quote";
    else if (tag === "figcaption") kind = "caption";
    if (kind === "code")
      text = (node.textContent || "").replace(/\r\n?/g, "\n").trimEnd();
    else if (kind === "table")
      text = [...node.querySelectorAll("tr")]
        .map((row) =>
          [...row.querySelectorAll("th,td")]
            .map((cell) => clean(cell.textContent || ""))
            .join("\t"),
        )
        .join("\n");
    else if (kind === "list")
      text = [...node.querySelectorAll("li")]
        .map((li) => clean(li.textContent || ""))
        .join("\n");
    else text = clean(node.textContent || "");
    if (!text.trim()) continue;
    originalChars += text.length;
    if (
      blocks.length >= 500 ||
      text.length > 20000 ||
      blocks.reduce((n, b) => n + b.text.length + 2, 0) + text.length > maxChars
    ) {
      truncated = true;
      continue;
    }
    blocks.push({
      kind,
      text,
      locator: `block:${index}`,
      headingPath: headings.filter(Boolean),
      ...(/^h[1-6]$/.test(tag) ? { level: Number(tag[1]) } : {}),
    });
  }
  if (!blocks.length) {
    // For modern SPAs where content is rendered inside divs/sections without standard <p> tags
    const contentDivs = [...root.querySelectorAll("div,section,article,[role='article'],[data-message-author-role]")].filter((node) => {
      const text = clean(node.textContent || "");
      if (text.length < 20) return false;
      return !node.querySelector("div,section,article,p,pre,table,ul,ol");
    });
    for (const [index, node] of contentDivs.entries()) {
      const text = clean(node.textContent || "");
      if (!text) continue;
      originalChars += text.length;
      if (
        blocks.length >= 500 ||
        text.length > 20000 ||
        blocks.reduce((n, b) => n + b.text.length + 2, 0) + text.length > maxChars
      ) {
        truncated = true;
        continue;
      }
      blocks.push({
        kind: "paragraph",
        text,
        locator: `div:${index}`,
        headingPath: [],
      });
    }
  }
  if (!blocks.length) {
    const text = clean(root.textContent || "");
    originalChars = text.length;
    for (
      let offset = 0;
      offset < Math.min(text.length, maxChars) && blocks.length < 500;
      offset += 20000
    )
      blocks.push({
        kind: "paragraph",
        text: text.slice(offset, Math.min(offset + 20000, maxChars)),
        locator: `block:${offset}`,
        headingPath: [],
      });
    truncated ||= text.length > maxChars;
  }
  const resolve = (value: string) => {
    try {
      const u = new URL(value, baseUrl);
      return /^https?:$/.test(u.protocol) &&
        !u.username &&
        !u.password &&
        u.href.length <= 8192
        ? u.href
        : "";
    } catch {
      return "";
    }
  };
  const links = [...root.querySelectorAll("a[href]")]
    .map((a) => ({
      url: resolve(a.getAttribute("href") || ""),
      text: clean(a.textContent || "").slice(0, 500),
      rel: (a.getAttribute("rel") || "").slice(0, 200),
    }))
    .filter((x) => x.url)
    .filter((x, i, all) => all.findIndex((y) => y.url === x.url) === i)
    .slice(0, 100);
  const images = [...root.querySelectorAll("img")]
    .map((img) => ({
      url: resolve(
        (img as HTMLImageElement).currentSrc ||
          img.getAttribute("src") ||
          img.getAttribute("data-src") ||
          "",
      ),
      alt: (img.getAttribute("alt") || "").slice(0, 1000),
      width: Math.floor(
        Math.min(
          100000,
          Math.max(
            0,
            Number(img.getAttribute("width")) ||
              (img as HTMLImageElement).naturalWidth ||
              0,
          ),
        ),
      ),
      height: Math.floor(
        Math.min(
          100000,
          Math.max(
            0,
            Number(img.getAttribute("height")) ||
              (img as HTMLImageElement).naturalHeight ||
              0,
          ),
        ),
      ),
    }))
    .filter((x) => x.url)
    .filter((x, i, all) => all.findIndex((y) => y.url === x.url) === i)
    .slice(0, 25);
  const text = blocks.map((b) => b.text).join("\n\n");
  const extraction: ExtractionInfo = {
    method,
    version: "blocks-v1",
    quality: text.length >= 100 ? (truncated ? "partial" : "full") : "metadata",
    truncated,
    originalChars,
    reasons: truncated ? ["Content exceeded extraction budget"] : [],
  };
  // Reconstructed allowlisted HTML contains no live page attributes or executable content.
  const htmlParts: string[] = [];
  let htmlSize = 19;
  for (const block of blocks) {
    const tag =
      block.kind === "heading"
        ? `h${block.level || 2}`
        : block.kind === "code"
          ? "pre"
          : "p";
    const part = `<${tag}>${escape(block.text)}</${tag}>`;
    if (htmlSize + part.length > 200000) {
      extraction.truncated = true;
      extraction.quality = text.length >= 100 ? "partial" : "metadata";
      if (
        !extraction.reasons.includes(
          "Sanitized HTML exceeded extraction budget",
        )
      )
        extraction.reasons.push("Sanitized HTML exceeded extraction budget");
      continue;
    }
    htmlParts.push(part);
    htmlSize += part.length;
  }
  const html = "<article>" + htmlParts.join("") + "</article>";
  return { text, blocks, html, links, images, extraction };
}
