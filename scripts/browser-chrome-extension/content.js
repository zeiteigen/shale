/**
 * Content extractor for Shale Browser Ingestor.
 * Extracts clean, readable text and metadata from the active DOM.
 */

function extractPageContent() {
  const MAX_HTML_CHARS = 100000;
  const MAX_LINKS = 250;
  const MAX_IMAGES = 50;
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

  const links = Array.from(document.querySelectorAll("a[href]"))
    .map((link) => ({
      url: link.href,
      text: (link.innerText || link.textContent || "").trim().slice(0, 300),
      rel: link.rel || "",
    }))
    .filter((link) => /^https?:/i.test(link.url))
    .filter((link, index, all) => all.findIndex((other) => other.url === link.url) === index)
    .slice(0, MAX_LINKS);

  const images = Array.from(document.images)
    .map((img) => ({
      url: img.currentSrc || img.src || img.dataset.src || "",
      alt: (img.alt || "").trim().slice(0, 500),
      width: img.naturalWidth || img.width || 0,
      height: img.naturalHeight || img.height || 0,
    }))
    .filter((image) => /^https?:/i.test(image.url))
    .filter((image, index, all) => all.findIndex((other) => other.url === image.url) === index)
    .slice(0, MAX_IMAGES);

  // The server-side web parser uses the original markup for structure and image
  // discovery. Cap it so unusually large/SPAs cannot overwhelm the ingest API.
  const html = document.documentElement?.outerHTML?.slice(0, MAX_HTML_CHARS) || "";

  // Clone document body to sanitize without modifying the live page
  let textContent = "";
  try {
    if (document.body) {
      const clone = document.body.cloneNode(true);

      // Remove unwanted and clutter tags
      const elementsToRemove = clone.querySelectorAll(
        "script, style, noscript, svg, nav, header, footer, iframe, aside, [aria-hidden='true'], .advertisement, .ad, #ad",
      );
      elementsToRemove.forEach((el) => el.remove());

      // Extract innerText or textContent
      const rawText = clone.innerText || clone.textContent || "";
      textContent = rawText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join("\n");
    }
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
