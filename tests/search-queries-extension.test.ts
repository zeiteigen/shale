import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { createExtensionSDK, createMessageBus, type ShaleSDK } from "../sdk";
import { isTExtensionManifest } from "../lib/extension";
import { MEMORY_LIMITS } from "../lib/memory/types";
import manifest from "../extensions/search-queries/manifest.json";
import {
  SEARCH_PROTOCOL_VERSION, cleanUrl, parseSearchUrl, queryKey, unwrapRedirect, validateSearchBatch,
  type SearchQueryRecord, type SearchRecord, type SearchVisitRecord,
} from "../extensions/search-queries/contract";
import { accept, inspect } from "../extensions/search-queries/subscribe";
import { run as index } from "../extensions/search-queries/index";
import { splitText } from "../extensions/search-queries/source";
import { createTestDatabase } from "./fixtures/database";

const T0 = Date.UTC(2026, 0, 5, 10, 0);
const at = (minute: number) => T0 + minute * 60_000;

let directory: string;
let database: ReturnType<typeof createTestDatabase>;
let sdk: ShaleSDK;

function configure(settings: Record<string, unknown> = {}) {
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ namespace: "search-queries", settleMinutes: 0, ...settings }));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "shale-search-queries-"));
  database = createTestDatabase();
  sdk = createExtensionSDK("search-queries", { database, messageBus: createMessageBus(), extensionDir: directory });
  sdk.logger.log = () => {};
  sdk.logger.warn = () => {};
  sdk.logger.error = () => {};
  configure();
});

afterEach(() => {
  sdk.messages.clear();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

let batches = 0;
async function send(records: SearchRecord[], collectorId = "collector-1") {
  const content = JSON.stringify({ type: "search_batch", protocolVersion: SEARCH_PROTOCOL_VERSION, collectorId,
    batchId: `batch-${++batches}`, records });
  return accept({ target_processor: "search-queries", content, metadata: { connector: "chrome-extension", data_origin: "chrome" } }, sdk);
}

function search(overrides: Partial<SearchQueryRecord> = {}): SearchQueryRecord {
  return {
    type: "search_query", recordId: "search:s1:a", searchId: "s1", engine: "google", query: "Rust lifetimes",
    url: "https://www.google.com/search?q=Rust+lifetimes", searchedAt: at(0),
    aiOverview: { text: "Lifetimes describe how long references stay valid.\nThe compiler checks them.",
      citations: [{ title: "The Rust Book", url: "https://doc.rust-lang.org/book/" }] },
    results: [
      { url: "https://doc.rust-lang.org/book/ch10-03-lifetime-syntax.html", title: "Validating References with Lifetimes",
        description: "Lifetimes ensure references are valid as long as we need them.", rank: 1 },
      { url: "https://example.org/lifetimes", title: "Lifetimes explained", rank: 2 },
    ],
    ...overrides,
  };
}

function visit(overrides: Partial<SearchVisitRecord> = {}): SearchVisitRecord {
  return {
    type: "search_visit", recordId: "visit:v1", searchId: "s1", engine: "google", query: "Rust lifetimes",
    url: "https://doc.rust-lang.org/book/ch10-03-lifetime-syntax.html", title: "Lifetimes - The Rust Book", visitedAt: at(1),
    ...overrides,
  };
}

const sources = () => database.query<{ id: string; title: string; type: string; origin: string; uri: string; created_at: number; updated_at: number }, []>(
  "SELECT id,title,type,origin,uri,created_at,updated_at FROM sources WHERE type='web_search' ORDER BY id").all();
const chunks = (sourceId: string) => database.query<{ chunk_index: number; chunk_type: string; text_content: string }, [string]>(
  "SELECT chunk_index,chunk_type,text_content FROM chunks WHERE source_id=? ORDER BY chunk_index").all(sourceId);

describe("search-queries contract", () => {
  it("has an auto-discoverable manifest with a Chrome module", () => {
    expect(isTExtensionManifest(manifest)).toBe(true);
    expect(manifest.chrome_module.inject).toEqual({ serp: "chrome/inject/serp.ts" });
  });

  it("recognises results pages of each engine, but not other tabs or pages", () => {
    expect(parseSearchUrl("https://www.google.com/search?q=rust+lifetimes&sca_esv=1")).toEqual({ engine: "google", query: "rust lifetimes" });
    expect(parseSearchUrl("https://www.google.co.uk/search?q=tea")).toEqual({ engine: "google", query: "tea" });
    expect(parseSearchUrl("https://google.com.au/search?q=surf")?.engine).toBe("google");
    expect(parseSearchUrl("https://www.bing.com/search?q=borrow+checker&form=QBLH")).toEqual({ engine: "bing", query: "borrow checker" });
    expect(parseSearchUrl("https://duckduckgo.com/?q=privacy&t=h_")).toEqual({ engine: "duckduckgo", query: "privacy" });
    expect(parseSearchUrl("https://www.google.com/search?q=cats&tbm=isch")).toBeUndefined();
    expect(parseSearchUrl("https://www.google.com/search?q=cats&udm=2")).toBeUndefined();
    expect(parseSearchUrl("https://www.bing.com/images/search?q=cats")).toBeUndefined();
    expect(parseSearchUrl("https://duckduckgo.com/?q=cats&iax=images&ia=images")).toBeUndefined();
    expect(parseSearchUrl("https://www.google.com/search")).toBeUndefined();
    expect(parseSearchUrl("https://docs.google.com/search?q=x")).toBeUndefined();
    expect(parseSearchUrl("https://evilgoogle.com/search?q=x")).toBeUndefined();
    expect(queryKey("  Rust   LIFETIMES ")).toBe("rust lifetimes");
  });

  it("unwraps click trackers and cleans tracking parameters", () => {
    const target = "https://doc.rust-lang.org/book/?x=1";
    expect(unwrapRedirect(`https://www.google.com/url?q=${encodeURIComponent(target)}&sa=U`)).toBe(target);
    const bing = `a1${btoa(target).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
    expect(unwrapRedirect(`https://www.bing.com/ck/a?!&&p=abc&u=${bing}&ntb=1`)).toBe(target);
    expect(unwrapRedirect(`https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=1`)).toBe(target);
    expect(unwrapRedirect("https://example.com/")).toBe("https://example.com/");
    expect(cleanUrl("https://example.com/a?utm_source=google&id=4&srsltid=z#top")).toBe("https://example.com/a?id=4");
  });

  it("validates batches", () => {
    const batch = { type: "search_batch", protocolVersion: SEARCH_PROTOCOL_VERSION, collectorId: "c", batchId: "b", records: [search()] };
    expect(validateSearchBatch(batch)).toBe(batch as any);
    expect(() => validateSearchBatch({ ...batch, protocolVersion: 99 })).toThrow(/protocol version/);
    expect(() => validateSearchBatch({ ...batch, records: [search({ url: "https://www.bing.com/search?q=x" })] })).toThrow(/url/);
    expect(() => validateSearchBatch({ ...batch, records: [visit({ url: "javascript:alert(1)" })] })).toThrow(/url/);
    expect(() => validateSearchBatch({ ...batch, records: [search({ aiOverview: {
      text: "Overview", citations: [{ url: "https://example.com/" } as any],
    } })] })).toThrow(/title/);
    expect(() => validateSearchBatch({ ...batch, records: [search(), search()] })).toThrow(/recordId/);
  });

  it("splits long text at line or word boundaries within the limits", () => {
    const pieces = splitText(`${"word ".repeat(400)}\n${"next ".repeat(400)}`, 1200, 2);
    expect(pieces).toHaveLength(2);
    expect(pieces.every(piece => piece.length <= 1200)).toBe(true);
    expect(pieces[1]!.endsWith("…")).toBe(true);
  });
});

describe("search-queries server", () => {
  it("turns a search into a source with its AI Overview and opened results as snippets", async () => {
    const admitted = await send([search(), visit(), visit({ recordId: "visit:v2", url: "https://example.org/lifetimes?utm_source=x",
      title: undefined, visitedAt: at(2) })]);
    expect(admitted.records.map(record => record.status)).toEqual(["received", "received", "received"]);
    const result = await index(sdk, Date.now());
    expect(result).toMatchObject({ searches: 1, indexed: 1, errors: [] });
    const [source] = sources();
    expect(source).toMatchObject({ title: "Rust lifetimes (Google search)", origin: "search",
      uri: "search://google/rust%20lifetimes", created_at: at(0), updated_at: at(2) });
    const stored = chunks(source!.id);
    expect(stored[0]!.text_content).toBe('Searched Google for "Rust lifetimes" on 2026-01-05. Google showed an AI Overview. '
      + "Opened 2 results: Lifetimes explained (example.org); Lifetimes - The Rust Book (doc.rust-lang.org).");
    expect(stored.slice(1).map(chunk => chunk.text_content)).toEqual([
      "Google AI Overview:\nLifetimes describe how long references stay valid.\nThe compiler checks them.\n"
        + "Sources:\n- The Rust Book (https://doc.rust-lang.org/book/)",
      // Newest first; a visit without a title borrows the results page's.
      "Lifetimes explained\nhttps://example.org/lifetimes",
      "Lifetimes - The Rust Book\nhttps://doc.rust-lang.org/book/ch10-03-lifetime-syntax.html\n"
        + "Lifetimes ensure references are valid as long as we need them.",
    ]);
    expect(stored.slice(1).every(chunk => chunk.chunk_type === "verbatim")).toBe(true);
    const opened = database.query<{ n: number }, []>(
      "SELECT count(*) AS n FROM edges WHERE relation='OPENED_RESULT'").get()!.n;
    expect(opened).toBe(2);
    // Nothing new: the next run has nothing to do.
    expect(await index(sdk, Date.now())).toMatchObject({ searches: 0 });
  });

  it("merges a repeated search into the same source and counts it once per search", async () => {
    await send([search(), visit()]);
    await index(sdk, Date.now());
    await send([search({ recordId: "search:s2:a", searchId: "s2", query: "rust  Lifetimes", searchedAt: at(60), aiOverview: undefined }),
      search({ recordId: "search:s2:b", searchId: "s2", query: "rust  Lifetimes", searchedAt: at(60),
        aiOverview: { text: "A newer overview.", citations: [] } }),
      visit({ recordId: "visit:v3", searchId: "s2", visitedAt: at(61) })]);
    await index(sdk, Date.now());
    const all = sources();
    expect(all).toHaveLength(1);
    const stored = chunks(all[0]!.id);
    expect(stored[0]!.text_content).toStartWith('Searched Google for "rust  Lifetimes" 2 times between 2026-01-05 and 2026-01-05.');
    expect(stored[1]!.text_content).toBe("Google AI Overview:\nA newer overview.");
    const row = database.query<{ visit_count: number }, []>("SELECT visit_count FROM search_visits").get()!;
    expect(row.visit_count).toBe(2);
  });

  it("waits for a search to settle before indexing it", async () => {
    configure({ settleMinutes: 5 });
    await send([search()]);
    const admittedAt = Date.now();
    expect(await index(sdk, admittedAt + 60_000)).toMatchObject({ searches: 0 });
    expect(await index(sdk, admittedAt + 6 * 60_000)).toMatchObject({ searches: 1, indexed: 1 });
  });

  it("retains the search time when a visit arrives before its results-page capture", async () => {
    await send([visit({ searchedAt: at(0), visitedAt: at(1) })]);
    await send([search()]);
    expect(await index(sdk, Date.now())).toMatchObject({ indexed: 1, errors: [] });
    expect(sources()[0]).toMatchObject({ created_at: at(0), updated_at: at(1) });
    const row = database.query<{ search_count: number; first_searched_at: number; last_searched_at: number }, []>(
      "SELECT search_count,first_searched_at,last_searched_at FROM search_queries").get()!;
    expect(row).toEqual({ search_count: 1, first_searched_at: at(0), last_searched_at: at(0) });
  });

  it("keeps a long overview and many results within the snippet budget", async () => {
    const paragraph = (n: number) => `Paragraph ${n}: ${"lifetimes are checked at compile time ".repeat(20)}`;
    await send([
      search({ aiOverview: { text: Array.from({ length: 12 }, (_, n) => paragraph(n)).join("\n"), citations: [] } }),
      ...Array.from({ length: 20 }, (_, n) => visit({ recordId: `visit:${n}`, url: `https://example.com/${n}`,
        description: "d".repeat(1500), visitedAt: at(1 + n) })),
    ]);
    expect((await index(sdk, Date.now())).errors).toEqual([]);
    const stored = chunks(sources()[0]!.id).slice(1);
    expect(stored.length).toBeLessThanOrEqual(MEMORY_LIMITS.snippets);
    expect(stored.every(chunk => chunk.text_content.length <= MEMORY_LIMITS.snippet)).toBe(true);
    expect(stored.reduce((n, chunk) => n + chunk.text_content.length, 0)).toBeLessThanOrEqual(MEMORY_LIMITS.snippetCharacters);
    expect(stored.filter(chunk => chunk.text_content.startsWith("Google AI Overview:")).length).toBe(1);
    // The newest opened result is always kept.
    expect(stored.some(chunk => chunk.text_content.includes("https://example.com/19"))).toBe(true);
  });

  it("skips disabled engines and overviews, and treats resent records as duplicates", async () => {
    configure({ engines: ["google"], captureAiOverview: false });
    const first = await send([search(), search({ recordId: "search:b", searchId: "s9", engine: "bing", query: "x",
      url: "https://www.bing.com/search?q=x", aiOverview: undefined })]);
    expect(first.records.map(record => record.status)).toEqual(["received", "skipped"]);
    expect(first.records[1]).toMatchObject({ reason: "bing capture is turned off in search-queries settings" });
    expect((await send([search()])).records[0]!.status).toBe("duplicate");
    await expect(send([search({ query: "changed" })])).rejects.toThrow(/reused with different content/);
    await index(sdk, Date.now());
    const stored = chunks(sources()[0]!.id);
    expect(stored.some(chunk => chunk.text_content.includes("AI Overview"))).toBe(false);
  });

  it("serves its capture policy and receipt status", async () => {
    configure({ engines: ["google", "duckduckgo"] });
    const policy = await (await inspect(new Request("http://x/connectors/search-queries/policy"), sdk)).json();
    expect(policy).toEqual({ protocolVersion: SEARCH_PROTOCOL_VERSION, engines: ["google", "duckduckgo"], captureAiOverview: true });
    const { records } = await send([search()]);
    const status = await (await inspect(new Request(`http://x/connectors/search-queries/status?ids=${records[0]!.jobId}`), sdk)).json();
    expect(status.records).toEqual([{ jobId: records[0]!.jobId, status: "indexed" }]);
  });
});

describe("search-queries Chrome module", () => {
  it("captures results pages and the results opened from them", () => {
    const result = spawnSync(process.execPath, ["run", join(import.meta.dir, "fixtures/search-queries-chrome.mjs")], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("Search queries module checks passed");
  });

  it("reads Google's results and AI Overview from the page", async () => {
    const { window, document } = parseHTML(`<html><body><div id="center_col">
      <div id="ai"><div><h2>AI Overview</h2></div>
        <div><p>Lifetimes describe how long references stay valid.</p><ul><li>They are checked at compile time.</li></ul>
          <div><a href="https://doc.rust-lang.org/book/">The Rust Book</a></div><div role="button">Show more</div></div>
        <div>AI responses may include mistakes. Learn more</div></div>
      <div id="search"><div id="rso">
        <div class="MjjYud"><a href="https://www.google.com/url?q=https://example.org/lifetimes&amp;sa=U"><h3>Lifetimes explained</h3></a>
          <div class="VwiC3b">A friendly guide to lifetimes.</div></div>
        <div class="MjjYud"><a href="https://www.google.com/search?q=related"><h3>Related searches</h3></a></div>
      </div></div></div></body></html>`);
    const globals = { document, window, Node: window.Node, NodeFilter: { SHOW_TEXT: 4 },
      location: { href: "https://www.google.com/search?q=rust+lifetimes" } };
    const saved = Object.fromEntries(Object.keys(globals).map(key => [key, (globalThis as any)[key]]));
    Object.assign(globalThis, globals);
    try {
      const { default: read } = await import("../extensions/search-queries/chrome/inject/serp.ts");
      const page = await read({ engine: "google", overview: true });
      expect(page).toMatchObject({ url: "https://www.google.com/search?q=rust+lifetimes",
        results: [{ url: "https://example.org/lifetimes", title: "Lifetimes explained", description: "A friendly guide to lifetimes.", rank: 1 }] });
      expect((page as any).overview).toEqual({ complete: true,
        text: "Lifetimes describe how long references stay valid.\nThey are checked at compile time.\nThe Rust Book",
        citations: [{ title: "The Rust Book", url: "https://doc.rust-lang.org/book/" }] });
    } finally {
      Object.assign(globalThis, saved);
    }
  });
});
