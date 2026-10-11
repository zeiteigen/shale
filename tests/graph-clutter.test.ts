import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { createExtensionSDK, createMessageBus, SourceGraph } from "../sdk";
import { createTestDatabase } from "./fixtures/database";
import { canonicalUrl } from "../extensions/browser/filter";
import { isDecorativeImage, isGenericAnchor } from "../extensions/browser/page-graph";
import { isUiChromeTopic, sanitizeTopics } from "../extensions/browser/identity";
import { preparePageVisit, finalizePageVisit, processHistoryBatch } from "../extensions/browser/ingest-processor";
import { finalizeActivity } from "../extensions/browser/activity-graph";
import { commitContextGraph } from "../extensions/browser/context-graph";
import { ensureBrowserSchema } from "../extensions/browser/storage-schema";
import { getGraphData } from "../visualizer/graph-data";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = createTestDatabase(); databases.push(db);
  ensureBrowserSchema(db);
  const sdk = createExtensionSDK("browser", { database: db, namespace: "browser", messageBus: createMessageBus() });
  sdk.settings.get = ((key: string) => ({ namespace: "browser", enableLlmAnalysis: false } as Record<string, unknown>)[key]) as typeof sdk.settings.get;
  sdk.settings.getAll = (() => ({ namespace: "browser", enableLlmAnalysis: false })) as typeof sdk.settings.getAll;
  return { db, sdk };
}
const count = (db: Database, sql: string, ...params: (string | number)[]) =>
  db.query<{ n: number }, (string | number)[]>(sql).get(...params)!.n;

describe("URL canonicalization", () => {
  it("drops text-highlight fragments and Google presentation params but keeps SPA routes", () => {
    expect(canonicalUrl("https://example.com/a#:~:text=hello%20world")).toBe("https://example.com/a");
    expect(canonicalUrl("https://example.com/app#/route:~:text=x")).toBe("https://example.com/app#/route");
    expect(canonicalUrl("https://www.google.com/search?q=spring+force+formula&ie=UTF-8&udm=50&oq=spring"))
      .toBe(canonicalUrl("https://www.google.com/search?q=spring+force+formula"));
    // Presentation params are only noise on Google; elsewhere they may be content.
    expect(canonicalUrl("https://example.com/page?sa=1")).toBe("https://example.com/page?sa=1");
    expect(canonicalUrl("chrome://settings")).toBe("chrome://settings");
  });
});

describe("page graph filters", () => {
  it("recognizes decorative images and generic anchors", () => {
    expect(isDecorativeImage({ url: "https://t1.gstatic.com/faviconV2?client=bard&type=favicon&url=x" })).toBe(true);
    expect(isDecorativeImage({ url: "https://example.com/favicon.ico" })).toBe(true);
    expect(isDecorativeImage({ url: "https://example.com/pixel.png", width: 1, height: 1 })).toBe(true);
    expect(isDecorativeImage({ url: "data:image/png;base64,AAAA" })).toBe(true);
    expect(isDecorativeImage({ url: "https://example.com/diagram.png", width: 640 })).toBe(false);
    expect(isGenericAnchor("Read more »")).toBe(true);
    expect(isGenericAnchor("  ")).toBe(true);
    expect(isGenericAnchor("SQLite query planner")).toBe(false);
  });

  it("links only known pages as nodes, keeps others as values, and skips favicons", async () => {
    const { db, sdk } = fixture();
    await processHistoryBatch(sdk, { type: "history_batch", items: [{ url: "https://known.com/page", title: "Known title", visitTime: 500 }] }, {});
    const prepared = (await preparePageVisit(sdk, {
      type: "page_visit", url: "https://example.com/guide", title: "Guide", visitedAt: 1000, recordInSession: false,
      textContent: "A guide about database indexes and their performance. ".repeat(5),
      links: [
        { url: "https://known.com/page#:~:text=quote", text: "a page I visited" },
        { url: "https://unvisited.com/article", text: "An article about B-trees" },
        { url: "https://unvisited.com/article", text: "Same article again" },
        { url: "https://unvisited.com/other", text: "Read more" },
      ],
      images: [
        { url: "https://t1.gstatic.com/faviconV2?client=bard&type=favicon&url=x", alt: "" },
        { url: "https://example.com/diagram.png", alt: "Index diagram", width: 640, height: 480 },
      ],
    }, { enableLlmAnalysis: false }))!;
    await finalizePageVisit(sdk, prepared, {});
    const references = sdk.graph.claims.list({ predicate: "REFERENCES" });
    expect(references).toHaveLength(1);
    expect(sdk.graph.entities.get(references[0].object!).name).toBe("Known title");
    expect(sdk.graph.claims.list({ predicate: "LINKS_TO" }).map(c => c.value)).toEqual(["https://unvisited.com/article"]);
    expect(count(db, "SELECT count(*) n FROM entities WHERE type='WebPage'")).toBe(2);
    expect(count(db, "SELECT count(*) n FROM entities WHERE type='Image'")).toBe(1);
  });
});

describe("history and activity", () => {
  it("records history aggregates on the page without a HistoryRecord node or event", async () => {
    const { db, sdk } = fixture();
    await processHistoryBatch(sdk, { type: "history_batch", items: [{ url: "https://example.com/a", title: "A", visitTime: 2000, visitCount: 3 }] }, {});
    expect(count(db, "SELECT count(*) n FROM entities WHERE type='HistoryRecord'")).toBe(0);
    expect(count(db, "SELECT count(*) n FROM graph_events")).toBe(0);
    const [visits] = sdk.graph.claims.list({ predicate: "VISIT_COUNT" });
    expect(visits.value).toBe(3);
    expect(sdk.graph.entities.get(visits.subject).type).toBe("WebPage");
    expect(sdk.graph.entities.resolve(db.query<{ id: string }, []>("SELECT id FROM sources").get()!.id, "source-id")[0].id).toBe(visits.subject);
  });

  it("folds attention, activation and close into claims on the navigation's visit event", async () => {
    const { db, sdk } = fixture();
    const base = { type: "activity_event" as const, collectorId: "c", url: "https://example.com/a", title: "A", tabId: 1 };
    await finalizeActivity(sdk, { ...base, eventId: "nav", kind: "navigation", visitedAt: 1000 } as any, {}, () => {}, () => {});
    await finalizeActivity(sdk, { ...base, eventId: "att", kind: "attention", navigationEventId: "nav", visitedAt: 1500, durationMs: 4200, attended: true } as any, {}, () => {}, () => {});
    await finalizeActivity(sdk, { ...base, eventId: "act", kind: "activation", navigationEventId: "nav", visitedAt: 1600 } as any, {}, () => {}, () => {});
    await finalizeActivity(sdk, { ...base, eventId: "cls", kind: "close", visitedAt: 2000 } as any, {}, () => {}, () => {});
    expect(count(db, "SELECT count(*) n FROM graph_events")).toBe(1);
    const visit = sdk.graph.events.list({ kind: "page_visit" })[0];
    expect(sdk.graph.claims.list({ predicate: "ATTENTION_MS" })[0]).toMatchObject({ subject: visit.entity.id, value: 4200 });
    expect(sdk.graph.claims.list({ predicate: "ACTIVATED_AT" })[0]).toMatchObject({ subject: visit.entity.id, value: 1600 });
    // Without a navigation link the measurement attaches to the page.
    const closed = sdk.graph.claims.list({ predicate: "CLOSED_AT" })[0];
    expect(sdk.graph.entities.get(closed.subject).type).toBe("WebPage");
  });
});

describe("topics and threads", () => {
  it("rejects UI-chrome topics", () => {
    expect(isUiChromeTopic("Account Settings")).toBe(true);
    expect(sanitizeTopics(["Home", "API Keys", "New session", "SQLite indexes"])).toEqual(["SQLite indexes"]);
  });

  it("keeps domain-only threads out of the graph and omits topics equal to the thread label", () => {
    const { db, sdk } = fixture();
    sdk.ingest.sourceAndChunks({ namespace: "browser", source: { id: "session:s", uri: "browser-session://s", type: "browser_session", origin: "browser", title: "S" },
      chunks: [{ chunk_index: 0, chunk_type: "verbatim", text_content: "{}" }] });
    const visit = (eventId: string, url: string) => ({ eventId, url, title: url, domain: "example.com", visitedAt: 1 });
    commitContextGraph(sdk, "session:s", {
      sessionId: "s", startTime: 1, endTime: 2, namespace: "browser",
      synthesis: { sessionTitle: "S", summary: "", topics: [], dominantDomains: [] },
      visits: [visit("a", "https://example.com/a"), visit("b", "https://example.com/b")],
      threads: [
        { id: "t1", label: "Exploring example.com", topics: [], eventIds: ["a"], method: "heuristic", confidence: 0.5 },
        { id: "t2", label: "SQLite", topics: ["SQLite", "B-trees"], eventIds: ["b"], method: "heuristic", confidence: 0.5 },
      ],
    } as any);
    expect(db.query("SELECT coalesce(display_name,name) AS name FROM entities WHERE type='ResearchThread'").all()).toEqual([{ name: "SQLite" }]);
    expect(db.query("SELECT coalesce(display_name,name) AS name FROM entities WHERE type='Topic'").all()).toEqual([{ name: "B-trees" }]);
    expect(count(db, "SELECT count(*) n FROM browser_context_members")).toBe(2);
  });
});

describe("edge projection", () => {
  it("drops an edge when its last live claim goes stale, keeping independently supported edges", () => {
    const { db, sdk } = fixture();
    const source = (id: string) => sdk.ingest.sourceAndChunks({ namespace: "browser",
      source: { id, uri: `test://${id}`, type: "text", origin: "test", title: id }, chunks: [{ chunk_index: 0, text_content: id }] });
    source("one"); source("two");
    const one = new SourceGraph(db, sdk.graph, "one", "browser"), two = new SourceGraph(db, sdk.graph, "two", "browser");
    const a = one.entity("a", "A", "Topic"), b = one.entity("b", "B", "Topic"), c = one.entity("c", "C", "Topic");
    one.link(a, "RELATES_TO", b); one.link(a, "RELATES_TO", c); two.link(a, "RELATES_TO", c);
    db.query("UPDATE sources SET hash='changed' WHERE id='one'").run();
    const edges = db.query<{ target_entity_id: number }, []>("SELECT target_entity_id FROM edges ORDER BY target_entity_id").all();
    expect(edges.map(e => e.target_entity_id)).toEqual([c]);
  });
});

describe("visualizer", () => {
  it("hides events and their role edges and renders merged identities once", () => {
    const { sdk } = fixture();
    const a = sdk.graph.entities.create({ name: "A", type: "Topic" });
    const a2 = sdk.graph.entities.create({ name: "A duplicate", type: "Topic" });
    const b = sdk.graph.entities.create({ name: "B", type: "Topic" });
    sdk.graph.claims.add({ subject: a2.id, predicate: "RELATES_TO", object: b.id });
    sdk.graph.claims.add({ subject: a.id, predicate: "RELATES_TO", object: a2.id });
    sdk.graph.events.create({ name: "Visit", kind: "page_visit", participants: [{ entity: b.id, role: "page" }] });
    sdk.graph.entities.merge(a2.id, a.id, "duplicate");
    const graph = getGraphData(sdk);
    expect(graph.nodes.map(n => n.name).sort()).toEqual(["A", "B"]);
    expect(graph.edges.map(e => [e.source, e.target, e.relation])).toEqual([[a.id, b.id, "RELATES_TO"]]);
  });
});
