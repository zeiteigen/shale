import { expect, it } from "bun:test";
import { browserFixture } from "./fixtures/browser-connector";
import { preparePageVisit, finalizePageVisit } from "../extensions/browser/page-ingest";
import { refreshBrowserSource } from "../extensions/browser/refresh";
import { browserSourceId } from "../extensions/browser/identity";

const url = "https://example.com/refreshable";
const extraction = (quality: "full" | "partial" | "metadata", method: string, chars: number) => ({
  method, version: "test-v1", quality, truncated: false, originalChars: chars, reasons: [],
});
function installParser(f: ReturnType<typeof browserFixture>, publicText: string, publicQuality: "full" | "partial" | "metadata") {
  let publicCalls = 0;
  f.sdk.messages.bus.clear();
  f.sdk.messages.bus.handle("web:parse", (input: any) => {
    const isPublic = input.allowFetch === true;
    if (isPublic) publicCalls++;
    const text = isPublic ? publicText : "Authenticated article with detailed retained facts. ".repeat(20);
    return { title: isPublic ? "Public capture" : "Authenticated article", text, chunks: [text],
      contextualSummary: "", imageUrls: [], imageChunks: [],
      extraction: extraction(isPublic ? publicQuality : "full", isPublic ? "public-fetch" : "live-dom", text.length) };
  }, { extensionId: "web-page-parser", name: "web-page-parser", priority: 100 });
  return () => publicCalls;
}
async function ingestLive(f: ReturnType<typeof browserFixture>) {
  const settings = { allowPublicPageEnrichment: true, enableLlmAnalysis: false, enableImageAnalysis: false,
    chunkSize: 1000, namespace: "browser" } as any;
  const prepared = await preparePageVisit(f.sdk, { type: "page_visit", url, title: "Authenticated article",
    textContent: "DOM capture", visitedAt: Date.now(), capturedAt: Date.now(), recordInSession: false,
    collectorId: "test", recordId: "live-capture", eventId: "live-event" }, settings, { managed: true });
  await finalizePageVisit(f.sdk, prepared!, settings);
  return { settings, sourceId: browserSourceId("web", url) };
}

it("returns unavailable when public enrichment is disabled", async () => {
  const f = browserFixture();
  try {
    const calls = installParser(f, "Public article", "full");
    await ingestLive(f);
    f.sdk.settings.getAll = () => ({ allowPublicPageEnrichment: false, enableLlmAnalysis: false } as any);
    const result = await refreshBrowserSource(f.sdk, { sourceId: browserSourceId("web", url), actor: "test", reason: "refresh" });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("enable public page enrichment");
    expect(calls()).toBe(0);
  } finally { f.database.close(); }
});

it("routes successful public refresh through bounded memory on the canonical page source", async () => {
  const f = browserFixture();
  try {
    const longPublicText = "Publicly refreshed reference material. ".repeat(2000);
    const calls = installParser(f, longPublicText, "full");
    const { settings, sourceId } = await ingestLive(f);
    f.sdk.settings.getAll = () => settings;
    const before = f.sdk.memory.get(sourceId);
    const result = await refreshBrowserSource(f.sdk, { sourceId, actor: "test", reason: "refresh" });
    const after = f.sdk.memory.get(sourceId);
    expect(result.status).toBe("refreshed");
    expect(calls()).toBe(1);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.snippets.length).toBeLessThanOrEqual(16);
    expect(after.snippets.reduce((n, item) => n + item.text.length, 0)).toBeLessThanOrEqual(12000);
    expect(f.database.query<any, [string]>("SELECT count(*) AS n FROM sources WHERE id=? AND type='web_page'").get(sourceId).n).toBe(1);
    expect(f.database.query<any, []>("SELECT count(*) AS n FROM sources WHERE type='public_web_page'").get().n).toBe(0);
    const receipt = JSON.parse(f.database.query<any, [string]>("SELECT prepared FROM browser_content_cache WHERE source_id=? AND json_extract(prepared,'$.cacheState')='complete' ORDER BY updated_at DESC LIMIT 1").get(sourceId).prepared);
    expect(receipt.memory).toBeUndefined();
    expect(receipt.pageData).toBeUndefined();
    expect(receipt.analysis).toBeUndefined();
  } finally { f.database.close(); }
});

it("does not replace superior live memory with a metadata-quality login capture", async () => {
  const f = browserFixture();
  try {
    installParser(f, "Sign in to continue. Enter your password.", "metadata");
    const { settings, sourceId } = await ingestLive(f);
    f.sdk.settings.getAll = () => settings;
    const before = f.sdk.memory.get(sourceId);
    const result = await refreshBrowserSource(f.sdk, { sourceId, actor: "test", reason: "refresh" });
    const after = f.sdk.memory.get(sourceId);
    expect(result.status).toBe("unavailable");
    expect(after.version).toBe(before.version);
    expect(after.freshness.fingerprint).toBe(before.freshness.fingerprint);
    expect(after.snippets.some((item) => item.text.includes("Authenticated article"))).toBe(true);
    expect(after.snippets.some((item) => item.text.includes("Sign in to continue"))).toBe(false);
    const receipt = JSON.parse(f.database.query<any, [string]>("SELECT prepared FROM browser_content_cache WHERE source_id=? AND json_extract(prepared,'$.cacheState')='complete' ORDER BY updated_at DESC LIMIT 1").get(sourceId).prepared);
    expect(receipt.extraction.quality).toBe("full");
    expect(receipt.captureOrigin).toBe("live-dom");
  } finally { f.database.close(); }
});
