import { expect, it } from "bun:test";
import { parseHtmlSnapshot } from "../extensions/web-page-parser/readability";
import { parseWebPage } from "../extensions/web-page-parser/parser";
import { evaluateUrl } from "../extensions/browser/filter";
import { isDecorativeImage } from "../extensions/browser/page-graph";
import { preparePageVisit, finalizePageVisit } from "../extensions/browser/page-ingest";
import { admitBrowserPayload } from "../extensions/browser/admission";
import { runWorker } from "../extensions/browser/worker";
import { prepareSourceMemory } from "../lib/memory/prepare";
import { browserFixture, batch, capture, navigation } from "./fixtures/browser-connector";
import type { WebPageParseResponse } from "../lib/messages/web-contracts";

it("excludes DOM favicons and tracking pixels while retaining real diagrams", () => {
  const parsed = parseHtmlSnapshot(`<main><p>Index diagram.</p>
    <img src="/favicon.ico"><img src="/apple-touch-icon.png">
    <img src="/beacon.gif" width="1" height="1">
    <img src="/diagram.png" width="32" height="64"></main>`, "https://example.com/guide");
  expect(parsed.images.map((image) => image.url)).toEqual(["https://example.com/diagram.png"]);
  expect(parsed.html).not.toContain("favicon");
  expect(isDecorativeImage({ url: "https://example.com/beacon.gif", width: 1, height: 1 })).toBe(true);
  expect(isDecorativeImage({ url: "https://example.com/diagram.png", width: 32, height: 64 })).toBe(false);
});

it("never delegates decorative HTML or supplied icon URLs to vision", async () => {
  const requests: string[] = [];
  const sdk = {
    settings: { getAll: () => ({ enableLlmContext: false, maxImages: 8 }) },
    messages: { request: async (_channel: string, payload: { filePath: string }) => {
      requests.push(payload.filePath);
      return { success: true, chunks: [{ text_content: "Real image evidence", chunk_index: 0 }] };
    } },
    logger: { debug: () => {}, warn: () => {} },
  } as any;
  const iconOnly = await parseWebPage(sdk, {
    url: "https://example.com/guide", textContent: "Page text.",
    html: '<main><img src="/favicon.ico"><img src="/beacon.gif" width="1" height="1"></main>',
    imageUrls: ["https://example.com/apple-touch-icon.png", "https://www.google.com/s2/favicons?domain=example.com"],
  });
  expect(iconOnly.imageChunks).toEqual([]);
  expect(requests).toEqual([]);
  const real = await parseWebPage(sdk, {
    url: "https://example.com/guide", textContent: "Page text.",
    html: '<main><img src="/favicon.ico"><img src="/chart.png" width="32" height="64"></main>',
    imageUrls: ["https://cdn.example.com/photo.webp", "https://example.com/favicon.ico"],
  });
  expect(requests).toEqual(["https://cdn.example.com/photo.webp", "https://example.com/chart.png"]);
  expect(real.imageChunks).toHaveLength(2);
});

it("rejects decorative asset pages, history and bookmarks without rejecting articles about favicons", async () => {
  const f = browserFixture();
  f.policy.enableLlmAnalysis = false;
  f.policy.generateSessionSummaries = false;
  f.policy.fetchHistoryPages = false;
  const article = "https://example.com/articles/how-to-design-a-favicon";
  try {
    expect(evaluateUrl(article, {}).allowed).toBe(true);
    expect(evaluateUrl("https://example.com/favicon.ico", {}).allowed).toBe(false);
    expect(evaluateUrl("https://example.com/article?image=favicon.ico", {}).allowed).toBe(true);
    const receipt = admitBrowserPayload(f.sdk, batch([
      capture("asset-page", "https://example.com/favicon.ico"),
      { type: "history_item", recordId: "asset-history", id: "asset", title: "Icon", url: "https://example.com/apple-touch-icon.png", visitTime: Date.now() },
      { type: "bookmark_item", recordId: "asset-bookmark", id: "asset", title: "Icon", url: "https://www.google.com/s2/favicons?domain=example.com" },
      { type: "history_item", recordId: "article-history", id: "article", title: "Favicon guide", url: article, visitTime: Date.now() },
      { type: "bookmark_item", recordId: "article-bookmark", id: "article", title: "Favicon guide", url: article },
    ]));
    expect(receipt.records.map((record) => record.status)).toEqual(["skipped", "skipped", "skipped", "received", "received"]);
    await runWorker(f.sdk);
    expect(f.database.query("SELECT id FROM sources WHERE type='browser_history'").all()).toHaveLength(1);
    expect(f.database.query("SELECT id FROM sources WHERE type='bookmark'").all()).toHaveLength(1);
  } finally { f.database.close(); }
});

it("retains tiny substantive pages even with metadata extraction quality and a high length setting", async () => {
  const f = browserFixture();
  const settings = { enableLlmAnalysis: false, minContentLength: 1000, enableImageAnalysis: false };
  try {
    for (const [index, origin] of ["live-dom", "tab-metadata"].entries()) {
      const text = "π ≈ 3.14";
      const prepared = await preparePageVisit(f.sdk, {
        ...capture(`tiny:${index}`, `https://example.com/tiny/${index}`),
        title: "Pi", textContent: text, captureOrigin: origin as "live-dom" | "tab-metadata",
        extraction: { method: origin, version: "test-v1", quality: "metadata", truncated: false, originalChars: text.length, reasons: [] },
      }, settings, { managed: true });
      expect(prepared).not.toBeNull();
      const result = await finalizePageVisit(f.sdk, prepared!, settings);
      expect(f.sdk.memory.get(result!.sourceId).snippets.some((snippet) => snippet.text === text)).toBe(true);
    }
  } finally { f.database.close(); }
});

it("skips explicit title-only tab metadata while keeping activity and history receipts", async () => {
  const f = browserFixture();
  f.policy.enableLlmAnalysis = false;
  f.policy.generateSessionSummaries = false;
  f.policy.fetchHistoryPages = false;
  let parserCalls = 0;
  f.sdk.messages.bus.clear();
  f.sdk.messages.bus.handle("web:parse", () => { parserCalls++; throw new Error("Metadata should not invoke the parser"); }, { name: "web-page-parser" });
  const page = { ...capture("metadata"), textContent: "SQLite indexes", captureOrigin: "tab-metadata" as const,
    extraction: { method: "tab-metadata", version: "blocks-v1", quality: "metadata" as const, truncated: false, originalChars: 0, reasons: [] } };
  try {
    const receipt = admitBrowserPayload(f.sdk, batch([
      page,
      navigation("metadata-activity", page.visitedAt, 1, page.url),
      { type: "history_item", recordId: "metadata-history", id: "metadata-history", url: page.url, title: page.title, visitTime: page.visitedAt },
    ]));
    expect(receipt.records.every((record) => record.status === "received")).toBe(true);
    await runWorker(f.sdk);
    expect(parserCalls).toBe(0);
    expect(f.database.query("SELECT id FROM sources WHERE type='web_page'").all()).toHaveLength(0);
    expect(f.database.query("SELECT id FROM sources WHERE type='browser_activity'").all().length).toBeGreaterThan(0);
    expect(f.database.query("SELECT id FROM sources WHERE type='browser_history'").all()).toHaveLength(1);
    expect(f.database.query("SELECT event_id FROM browser_activity WHERE event_id='metadata-activity'").all()).toHaveLength(1);
    expect(f.database.query("SELECT id FROM browser_jobs WHERE state!='indexed'").all()).toHaveLength(0);
    expect(await preparePageVisit(f.sdk, { ...page, captureOrigin: undefined }, f.policy)).toBeNull();
  } finally { f.database.close(); }
});

it("filters old parser image chunks before memory selection and keeps real image evidence", async () => {
  const f = browserFixture();
  const text = "SQLite uses an index to find matching rows.";
  const icon = "https://example.com/favicon.ico", chart = "https://example.com/chart.png";
  const parsed: WebPageParseResponse = {
    title: "SQLite indexes", text, chunks: [text], contextualSummary: "", imageUrls: [icon, chart],
    imageChunks: [
      { text_content: "Decorative icon description", chunk_type: "synthetic", metadata: { assetUri: icon } },
      { text_content: "A chart of query costs", chunk_type: "synthetic", metadata: { assetUri: chart } },
    ],
    imageKnowledge: [
      { uri: icon, title: "Icon", claims: [{ predicate: "VISUAL_DESCRIPTION", value: "Icon", chunkIndex: 0, method: "vision", status: "proposed" }] },
      { uri: chart, title: "Query cost chart", claims: [{ predicate: "VISUAL_DESCRIPTION", value: "Query cost chart", chunkIndex: 1, method: "vision", status: "proposed" }] },
    ],
  };
  try {
    const prepared = await preparePageVisit(f.sdk, { ...capture("parser-images"), textContent: text },
      { enableLlmAnalysis: false, enableImageAnalysis: true }, { managed: true, parsed });
    expect(prepared!.memory.summary).not.toContain("Decorative icon");
    expect(prepared!.memory.snippets.some((snippet) => snippet.locator.assetUri === icon)).toBe(false);
    expect(prepared!.memory.snippets.some((snippet) => snippet.locator.assetUri === chart)).toBe(true);
    expect(prepared!.imageKnowledge?.map((image) => image.uri)).toEqual([chart]);
    expect(prepared!.imageKnowledge?.[0]?.claims[0]?.chunkIndex).toBe(0);
    const result = await finalizePageVisit(f.sdk, prepared!, { enableLlmAnalysis: false });
    expect(f.sdk.memory.get(result!.sourceId).snippets.some((snippet) => snippet.locator.assetUri === chart)).toBe(true);
    expect(f.database.query("SELECT id FROM entities WHERE type='Image'").all()).toHaveLength(1);
  } finally { f.database.close(); }
});

it("removes decorative image snippets and their overview from stale prepared memory on finalization", async () => {
  const f = browserFixture();
  try {
    const prepared = await preparePageVisit(f.sdk, capture("stale-images"), { enableLlmAnalysis: false }, { managed: true });
    const icon = "https://example.com/favicon.ico";
    prepared!.memory = prepareSourceMemory([
      { text_content: prepared!.pageData.textContent, chunk_type: "verbatim", chunk_index: 0 },
      { text_content: "Stale decorative icon description", chunk_type: "synthetic", chunk_index: 1, metadata: { assetUri: icon } },
    ], { title: prepared!.pageData.title });
    expect(prepared!.memory.summary).toContain("Stale decorative");
    const result = await finalizePageVisit(f.sdk, prepared!, { enableLlmAnalysis: false });
    const retained = f.sdk.memory.get(result!.sourceId);
    expect(retained.summary.text).not.toContain("Stale decorative");
    expect(retained.snippets.some((snippet) => snippet.locator.assetUri === icon)).toBe(false);
    expect(retained.snippets.some((snippet) => snippet.kind === "excerpt")).toBe(true);
  } finally { f.database.close(); }
});

it("skips stale prepared tab metadata without claiming a nonexistent page source", async () => {
  const f = browserFixture();
  try {
    const page = capture("stale-metadata");
    const receipt = admitBrowserPayload(f.sdk, batch([page]));
    const jobId = receipt.records[0]!.jobId;
    const prepared = await preparePageVisit(f.sdk, page, { enableLlmAnalysis: false }, { managed: true, jobId });
    prepared!.pageData = { ...prepared!.pageData, captureOrigin: "tab-metadata", textContent: page.title };
    prepared!.extraction = { method: "tab-metadata", version: "blocks-v1", quality: "metadata", truncated: false, originalChars: 0, reasons: [] };
    prepared!.memory = prepareSourceMemory([{ text_content: page.title }], { title: page.title });
    expect(await finalizePageVisit(f.sdk, prepared!, {})).toBeNull();
    expect(f.database.query("SELECT id FROM sources WHERE type='web_page'").all()).toHaveLength(0);
    const job = f.database.query<{ state: string; outcome: string }, [string]>("SELECT state,outcome FROM browser_jobs WHERE id=?").get(jobId)!;
    expect(job.state).toBe("indexed");
    expect(JSON.parse(job.outcome)).toEqual({ skipped: "tab-metadata" });
    expect(f.sdk.checkpoint.get(jobId)).toBeNull();
  } finally { f.database.close(); }
});

it("rechecks asset URL policy when recovering a page prepared before filtering",async()=>{
  const f=browserFixture();
  try {
    const prepared=await preparePageVisit(f.sdk,capture('old-asset'),{enableLlmAnalysis:false},{managed:true});
    prepared!.cleanUrl='https://example.com/favicon.ico';
    prepared!.pageData.url=prepared!.cleanUrl;
    expect(await finalizePageVisit(f.sdk,prepared!,{})).toBeNull();
    expect(f.database.query('SELECT id FROM sources').all()).toEqual([]);
  } finally {f.database.close();}
});
