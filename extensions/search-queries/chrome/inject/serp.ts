/**
 * Reads the search results page open in this tab: the organic results and, on Google, the
 * AI Overview. Every selector lives here, so an engine redesign is fixed in one file.
 * The overview streams in after the page loads, so this polls until its text stops changing.
 */
import { MAX_OVERVIEW_CHARS, MAX_RESULTS, searchEngineOf, unwrapRedirect, type Engine } from "../../contract";

const SELECTORS = {
  google: {
    result: "#rso a:has(h3), #search a:has(h3)",
    title: "h3",
    block: ".MjjYud, div.g, [data-hveid]",
    description: ".VwiC3b, [data-sncf], div[style*='line-clamp']",
    /** Where the overview's container must stop growing: the organic results and page columns. */
    boundary: "#rso, #search, #center_col, #rcnt, main, body",
    organic: ".MjjYud, div.g",
  },
  bing: {
    result: "#b_results > li.b_algo",
    link: "h2 a",
    description: ".b_caption p, p.b_lineclamp2, p.b_lineclamp3, p",
  },
  duckduckgo: {
    result: "article[data-testid='result']",
    link: "a[data-testid='result-title-a']",
    description: "[data-result='snippet']",
  },
} as const;

const OVERVIEW_TITLE = /^ai overview$/i;
/** Interface text inside the overview that is not part of the answer. */
const OVERVIEW_JUNK = [
  /^ai overview$/i, /^show (more|less|all)$/i, /^(learn more|listen|thank you|dismiss)$/i,
  /^ai responses may include mistakes/i, /^your feedback helps/i, /^generative ai is experimental/i,
  /^(an )?ai overview is not available/i, /^searching$/i, /^generating$/i, /^\+\d+$/,
];
const POLL_MS = 500;
const MAX_WAIT_MS = 12_000;
/** Without an overview heading by then, the page has none. */
const OVERVIEW_GRACE_MS = 4000;
const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DD|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|H[1-6]|HEADER|HR|LI|OL|P|PRE|SECTION|TABLE|TR|UL)$/;
const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|SVG|BUTTON|TEMPLATE|IMG)$/;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const text = (element: Element | null | undefined) =>
  ((element as HTMLElement | null)?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();

interface Result { url: string; title: string; description?: string; rank: number }

function external(href: string | null | undefined) {
  if (!href) return undefined;
  const url = unwrapRedirect(href);
  if (!/^https?:/i.test(url) || searchEngineOf(url)) return undefined;
  return url.slice(0, 4096);
}

function readResults(engine: Engine): Result[] {
  const found: Result[] = [];
  const seen = new Set<string>();
  const add = (href: string | null | undefined, title: string, description: string) => {
    const url = external(href);
    if (!url || seen.has(url) || found.length >= MAX_RESULTS) return;
    seen.add(url);
    found.push({ url, title: title.slice(0, 1000), ...(description ? { description: description.slice(0, 2000) } : {}),
      rank: found.length + 1 });
  };
  if (engine === "google") {
    const s = SELECTORS.google;
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>(s.result)) {
      // Links inside the AI Overview are its citations, not results.
      if (overviewRoot()?.contains(anchor)) continue;
      const block = anchor.closest(s.block);
      add(anchor.href, text(anchor.querySelector(s.title)), text(block?.querySelector(s.description)));
    }
  } else {
    const s = SELECTORS[engine];
    for (const item of document.querySelectorAll(s.result)) {
      const anchor = item.querySelector<HTMLAnchorElement>(s.link);
      add(anchor?.href, text(anchor), text(item.querySelector(s.description)));
    }
  }
  return found;
}

let cachedRoot: Element | null | undefined;
/** The smallest box around the "AI Overview" heading that holds the answer but no organic result. */
function overviewRoot(): Element | null {
  if (cachedRoot?.isConnected) return cachedRoot;
  const s = SELECTORS.google;
  // The heading is found by its text: Google's class names change often, its wording rarely.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let heading: Element | null = null;
  for (let node = walker.nextNode(); node && !heading; node = walker.nextNode())
    if (OVERVIEW_TITLE.test(node.textContent?.trim() ?? "")) heading = node.parentElement;
  if (!heading) return (cachedRoot = null);
  let root: Element = heading;
  for (let parent = root.parentElement; parent && !parent.matches(s.boundary); parent = parent.parentElement) {
    const organic = [...parent.querySelectorAll(s.organic)].some(block => !block.contains(heading));
    if (organic) break;
    root = parent;
  }
  return (cachedRoot = root === heading ? null : root);
}

/** Text with line breaks at block boundaries, including content collapsed behind "Show more". */
function blockText(node: Node, out: string[] = []): string[] {
  if (node.nodeType === Node.TEXT_NODE) out.push(node.textContent || "");
  else if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as Element;
    if (SKIP.test(element.tagName) || element.getAttribute("role") === "button") return out;
    const block = BLOCK.test(element.tagName);
    if (block) out.push("\n");
    for (const child of element.childNodes) blockText(child, out);
    if (block) out.push("\n");
  }
  return out;
}

function readOverview() {
  const root = overviewRoot();
  if (!root) return undefined;
  const visible = (root as HTMLElement).innerText || "";
  const full = blockText(root).join("");
  // Prefer what the user sees, unless most of the answer is collapsed.
  const raw = full.replace(/\s+/g, " ").length > visible.replace(/\s+/g, " ").length * 1.2 ? full : visible;
  const lines: string[] = [];
  for (const line of raw.split("\n").map(part => part.replace(/[ \t ]+/g, " ").trim())) {
    if (!line || OVERVIEW_JUNK.some(junk => junk.test(line)) || line === lines.at(-1)) continue;
    lines.push(line);
  }
  const citations: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const url = external(anchor.href);
    if (!url || seen.has(url) || citations.length >= 20) continue;
    seen.add(url);
    citations.push({ title: (anchor.getAttribute("aria-label") || text(anchor) || new URL(url).hostname).slice(0, 300), url });
  }
  const busy = !!root.querySelector("[aria-busy='true']");
  return { text: lines.join("\n").slice(0, MAX_OVERVIEW_CHARS), citations, busy };
}

export default async function readSearchPage(args: { engine: Engine; overview: boolean } | null) {
  const engine = args?.engine;
  if (!engine || !(engine in SELECTORS)) return { error: "Unknown search engine" };
  const started = Date.now();
  let results: Result[] = [];
  let overview: ReturnType<typeof readOverview>;
  let previous = "", stable = 0;
  while (true) {
    results = readResults(engine);
    overview = args.overview ? readOverview() : undefined;
    const elapsed = Date.now() - started;
    if (elapsed >= MAX_WAIT_MS) break;
    if (!args.overview) {
      if (results.length) break;
    } else if (overview) {
      // Settled: the same text twice in a row, with nothing still loading.
      stable = overview.text && overview.text === previous && !overview.busy ? stable + 1 : 0;
      previous = overview.text;
      if (stable >= 2) break;
    } else if (results.length && elapsed >= OVERVIEW_GRACE_MS) break;
    await sleep(POLL_MS);
  }
  return {
    url: location.href,
    results,
    ...(overview?.text ? { overview: { text: overview.text, citations: overview.citations, complete: stable >= 2 } } : {}),
  };
}
