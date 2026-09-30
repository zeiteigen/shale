/**
 * Content extractor for Shale Browser Ingestor.
 * Extracts clean, readable text and metadata from the active DOM.
 */

function extractPageContent() {
  const MAX_HTML_CHARS = 20000;
  const MAX_LINKS = 100;
  const MAX_IMAGES = 25;
  const url = window.location.href;
  const title =
    document.title ||
    document.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
    document.querySelector("h1")?.textContent?.trim() ||
    url;

  const metaDesc =
    document.querySelector('meta[name="description"]')?.getAttribute("content") ||
    document.querySelector('meta[property="og:description"]')?.getAttribute("content") ||
    "";

  const author =
    document.querySelector('meta[name="author"]')?.getAttribute("content") ||
    "";

  const favIconLink =
    document.querySelector('link[rel="icon"]') ||
    document.querySelector('link[rel="shortcut icon"]');
  const favIconUrl = favIconLink ? favIconLink.href : "";

  const contentRoot =
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.querySelector('[role="main"]') ||
    document.body;

  const links = Array.from(contentRoot?.querySelectorAll("a[href]") || [])
    .map((link) => ({
      url: link.href,
      text: (link.innerText || link.textContent || "").trim().slice(0, 300),
      rel: link.rel || "",
    }))
    .filter((link) => /^https?:/i.test(link.url))
    .filter((link, index, all) => all.findIndex((other) => other.url === link.url) === index)
    .slice(0, MAX_LINKS);

  const images = Array.from(contentRoot?.querySelectorAll("img") || [])
    .map((img) => ({
      url: img.currentSrc || img.src || img.dataset.src || "",
      alt: (img.alt || "").trim().slice(0, 500),
      width: img.naturalWidth || img.width || 0,
      height: img.naturalHeight || img.height || 0,
    }))
    .filter((image) => /^https?:/i.test(image.url))
    .filter((image, index, all) => all.findIndex((other) => other.url === image.url) === index)
    .slice(0, MAX_IMAGES);

  const SKIP_SELECTOR = [
    "script", "style", "noscript", "svg", "nav", "header", "footer",
    "iframe", "aside", "form", "dialog", "[aria-hidden='true']",
    ".advertisement", ".advert", ".ad", "#ad", "[role='navigation']",
  ].join(",");
  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "BLOCKQUOTE", "BR", "DD", "DIV", "DL", "DT",
    "FIGCAPTION", "FIGURE", "H1", "H2", "H3", "H4", "H5", "H6", "LI",
    "MAIN", "P", "PRE", "SECTION", "TABLE", "TD", "TH", "TR",
  ]);

  function extractStructuredText(root) {
    if (!root) return "";
    const parts = [];
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const value = (node.nodeValue || "").replace(/\s+/g, " ").trim();
        if (value) parts.push(value);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || node.matches?.(SKIP_SELECTOR)) return;
      const isBlock = BLOCK_TAGS.has(node.tagName);
      if (isBlock) parts.push("\n");
      for (const child of node.childNodes) walk(child);
      if (isBlock) parts.push("\n");
    }
    walk(root);
    const seenLines = new Set();
    return parts.join(" ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => {
        if (!line || seenLines.has(line)) return false;
        seenLines.add(line);
        return true;
      })
      .join("\n");
  }

  // Send only the selected content subtree, with executable/navigation clutter
  // removed. Prefix truncation of the full SPA document used to discard the
  // actual article while preserving unrelated menus and scripts.
  const htmlClone = contentRoot?.cloneNode(true);
  htmlClone?.querySelectorAll(SKIP_SELECTOR).forEach((element) => element.remove());
  const html = htmlClone?.outerHTML?.slice(0, MAX_HTML_CHARS) || "";

  let textContent = "";
  try {
    textContent = extractStructuredText(contentRoot);
  } catch (err) {
    textContent = metaDesc || title;
  }

  // Cap content length to 20,000 characters
  if (textContent.length > 20000) {
    textContent = textContent.slice(0, 20000);
  }

  return {
    url,
    title,
    excerpt: metaDesc || textContent.slice(0, 300),
    textContent: textContent || metaDesc || title,
    favIconUrl,
    author,
    html,
    links,
    images,
  };
}

// Respond to messages from background script
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === "extract_content") {
    sendResponse(extractPageContent());
  }
  return true;
});

// Self-invoking return if executed directly via scripting.executeScript
extractPageContent();
