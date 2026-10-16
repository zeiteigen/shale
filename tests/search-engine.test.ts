import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionSDK, type ShaleSDK } from "../sdk";
import { closeScopedSDKs, createScopedSDK } from "../sdk/access";
import { createTestDatabase } from "./fixtures/database";
import { classifyPending } from "../lib/access/classify";
import { indexSources } from "../sdk/retrieval/indexer";
import { refreshPhraseDictionary } from "../lib/text/terms";
import { indexEntity } from "../sdk/graph/registry";
import { buildUnits, prepareSearch, rankPrepared, searchSources, searchWeights } from "../sdk/retrieval/engine";
import { parseQuery } from "../sdk/retrieval/query";
import { collapse, mmr, profile } from "../sdk/retrieval/collapse";
import { bestPassage, minimalWindow, proximity, stemWord, DEFAULT_SEARCH_WEIGHTS } from "../sdk/retrieval/features";
import { coordinateAscent } from "../sdk/retrieval/ltr";
import { searchMemory } from "../sdk/memory/search";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpServer } from "../mcp";
import { createToken } from "../lib/access/tokens";

const directory = mkdtempSync(join(tmpdir(), "shale-search-engine-"));
const policyPath = process.env.SHALE_ACCESS_PATH!;
const NOW = Date.UTC(2026, 9, 15, 12);
const DAY = 86_400_000;
let db: Database;
let sdk: ShaleSDK;
let counter = 0;

function ingest(id: string, title: string, text: string, options: { origin?: string; uri?: string; type?: string; at?: number } = {}) {
  sdk.ingest.sourceAndChunks({ source: { id, uri: options.uri ?? `file:///vault/${id}.md`, title, origin: options.origin ?? "obsidian", type: options.type ?? "note",
    hash: `${id}-v1`, created_at: options.at ?? NOW - 30 * DAY, updated_at: options.at ?? NOW - 30 * DAY }, chunks: [{ text_content: text }] });
}

function entity(name: string, type: string, ...sourceIds: string[]) {
  const id = sdk.graph.entities.create({ name, type, namespace: "knowledge" }).id;
  for (const sourceId of sourceIds) db.query("INSERT OR IGNORE INTO source_entities VALUES(?,?)").run(sourceId, id);
  indexEntity(db, id);
  return id;
}

function build() { classifyPending(db, { budgetMs: 5_000 }); refreshPhraseDictionary(db, { force: true }); indexSources(db); }
const ids = (results: Array<{ sourceId: string }>) => results.map(result => result.sourceId);

beforeEach(() => {
  writeFileSync(policyPath, JSON.stringify({ defaultTier: "personal", unauthenticatedProfile: "local", originTiers: { discord: "private" }, tierRules: [],
    profiles: { local: { clearance: "secret" }, cloud: { clearance: "personal" } } }));
  db = createTestDatabase(join(directory, `engine-${counter++}.db`));
  sdk = createExtensionSDK("search-engine-test", { database: db, namespace: "knowledge" });
});
afterEach(() => { closeScopedSDKs(); db.close(); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("candidates and ranking", () => {
  it("ranks a title match above a body mention and relaxes a conjunction that matches nothing", () => {
    ingest("title", "Telescope maintenance log", "Cleaned the mirror and checked the mount.");
    ingest("body", "Saturday errands", "Bought groceries, then read about telescope collimation.");
    ingest("other", "Recipe", "A soup with leeks.");
    build();
    expect(ids(searchSources(db, "telescope", { now: NOW }))).toEqual(["title", "body"]);
    // No source has all three words: relaxation still finds the two that have two of them.
    const relaxed = searchSources(db, "telescope mirror zeppelin", { now: NOW });
    expect(ids(relaxed)[0]).toBe("title");
    expect(relaxed[0]!.matched.terms).toEqual(expect.arrayContaining(["telescope", "mirror"]));
    expect(relaxed[0]!.matched.fields).toContain("title");
  });

  it("finds sources by a linked entity's other names and explains the score", () => {
    ingest("cluster", "Cluster onboarding", "Got an account on the GPU cluster and ran the stencil benchmark.");
    ingest("noise", "Shopping list", "Milk, bread, eggs.");
    const hpc = entity("Waterloo High Performance Computing", "Organization", "cluster");
    sdk.graph.entities.addAlias(hpc, "whpc", "key:acronym");
    build();
    const results = searchSources(db, "WHPC", { now: NOW, explain: true });
    expect(ids(results)).toEqual(["cluster"]);
    expect(results.query.entities.map(item => item.id)).toEqual([hpc]);
    expect(results[0]!.matched.entities).toEqual([hpc]);
    expect(Object.keys(results[0]!.explain!)).toEqual(expect.arrayContaining(["bm25f", "coverage", "entity", "graph", "recency", "quality"]));
  });

  it("corrects a typo through the index vocabulary and trigram titles", () => {
    for (let i = 0; i < 4; i++) ingest(`w${i}`, `Waterloo admission ${i}`, `Admission letter ${i} from the university of waterloo.`);
    ingest("x", "Unrelated", "Nothing to see here.");
    build();
    const results = searchSources(db, "waterlo admision", { now: NOW });
    expect(results.length).toBe(4);
    expect(results.query.terms.map(term => term.corrected)).toEqual(["waterloo", "admission"]);
  });

  it("prefers upcoming dates for deadline wording and recent sources by default", () => {
    ingest("old", "Scholarship deadline", "The scholarship deadline was March 3, 2026.", { at: NOW - 220 * DAY });
    ingest("soon", "Housing deadline", "Submit the housing form. Deadline: October 20, 2026.", { at: NOW - 3 * DAY });
    build();
    const prepared = prepareSearch(db, parseQuery(db, "deadline", { now: NOW }), { now: NOW, ignoreTuned: true });
    const soon = prepared.candidates.find(candidate => candidate.sourceId === "soon")!, old = prepared.candidates.find(candidate => candidate.sourceId === "old")!;
    expect(soon.features.upcoming).toBeGreaterThan(old.features.upcoming);
    expect(soon.features.recency).toBeGreaterThan(old.features.recency);
    expect(ids(searchSources(db, "deadline", { now: NOW }))[0]).toBe("soon");
  });

  it("applies the default filters and the query's operators", () => {
    ingest("page", "Rocket history", "Rocket launches over the decades.", { origin: "browser", type: "browser_history" });
    ingest("mail", "Rocket club meeting", "[10:02] Nasser A. <nasser@example.com>: The rocket club meets Friday.", { origin: "email", type: "chat_session", uri: "email://inbox/thread/t1" });
    ingest("note", "Rocket notes", "Rocket staging notes.");
    build();
    expect(ids(searchSources(db, "rocket", { now: NOW })).sort()).toEqual(["mail", "note"]);
    expect(ids(searchSources(db, "rocket type:browser_history", { now: NOW }))).toEqual(["page"]);
    expect(ids(searchSources(db, "rocket origin:email", { now: NOW }))).toEqual(["mail"]);
    expect(ids(searchSources(db, "rocket from:nasser", { now: NOW }))).toEqual(["mail"]);
    expect(searchSources(db, "the of and", { now: NOW }).length).toBe(0);
  });
});

describe("results page", () => {
  it("collapses windows of one thread, identical titles, and near-identical mail into one hit", () => {
    const body = (n: number) => `[09:0${n}] Launchpad <hello@launchpad.example>: Nasser A. sent you a message on Launchpad. Open the app to read it. `
      + "You are receiving this because you joined the Efficient City challenge team and enabled notifications for direct messages from teammates. ".repeat(2);
    for (let n = 0; n < 4; n++) ingest(`notify-${n}`, `Message notification ${n}`, body(n), { origin: "email", type: "chat_session", uri: `email://inbox/thread/n${n}`, at: NOW - (10 - n) * DAY });
    ingest("w1", "Launchpad thread", "[10:00] Nasser A. <nasser@example.com>: Launchpad comment about the bike lanes.", { origin: "email", type: "chat_session", uri: "email://inbox/thread/T#window=1" });
    ingest("w2", "Launchpad thread later", "[11:00] Nasser A. <nasser@example.com>: Launchpad comment about the bus routes.", { origin: "email", type: "chat_session", uri: "email://inbox/thread/T#window=2" });
    ingest("t1", "Launchpad weekly digest", "Weekly launchpad digest one with Nasser.");
    ingest("t2", "Launchpad weekly digest", "Weekly launchpad digest two with Nasser.");
    build();
    const results = searchSources(db, "nasser launchpad", { now: NOW, limit: 20 });
    expect(results.length).toBe(3);
    const groups = results.map(result => [result.sourceId, ...result.similar].sort());
    expect(groups).toContainEqual(["notify-0", "notify-1", "notify-2", "notify-3"]);
    expect(groups).toContainEqual(["w1", "w2"]);
    expect(groups).toContainEqual(["t1", "t2"]);
    // Collapsing off: every source is its own hit.
    expect(searchSources(db, "nasser launchpad", { now: NOW, limit: 20, collapse: false }).length).toBe(8);
    expect(results.total).toBe(3);
  });

  it("picks the best-scoring representative, ties going to the most recent", () => {
    const groups = collapse([
      { id: "a", score: 1, at: 10, keys: ["k"] }, { id: "b", score: 1, at: 20, keys: ["k", "j"] }, { id: "c", score: 0.5, at: 5, keys: ["j"] }, { id: "d", score: 2, at: 1, keys: [] },
    ]);
    expect(groups.map(group => [group.item.id, group.similar])).toEqual([["d", []], ["b", ["a", "c"]]]);
  });

  it("diversifies the top results by title and entity overlap (MMR)", () => {
    const items = [
      { id: "a", score: 1.0, title: "Junior Academy team formation", entities: [1] },
      { id: "b", score: 0.99, title: "Junior Academy team formation reminder", entities: [1] },
      { id: "c", score: 0.9, title: "Purdue admission offer", entities: [2] },
    ];
    const order = (lambda: number) => mmr(items, item => item.score, item => profile(item.title, item.entities), lambda).map(item => item.id);
    expect(order(1)).toEqual(["a", "b", "c"]);
    expect(order(0.5)).toEqual(["a", "c", "b"]);
  });

  it("chooses the passage with the tightest window of query words, preferring a snippet", () => {
    expect(minimalWindow([{ at: 0, term: 0 }, { at: 9, term: 1 }, { at: 12, term: 0 }, { at: 13, term: 1 }], 2)).toEqual({ matched: 2, width: 2 });
    const terms = [[stemWord("grades")], [stemWord("calculator")]];
    const passage = bestPassage([
      { chunkIndex: 0, text: "Summary: a grade calculator project." },
      { chunkIndex: 1, text: "The grade weighting is explained later; the calculator comes much further on in the text." },
      { chunkIndex: 2, text: "Write a grade calculator in C++." },
    ], terms);
    expect(passage).toEqual({ chunkIndex: 2, matched: 2, window: 2 });
    expect(proximity(passage, 2)).toBeCloseTo(1);
    expect(proximity({ chunkIndex: 1, matched: 2, window: 12 }, 2)).toBeLessThan(0.5);
  });
});

describe("learning to rank", () => {
  it("coordinate ascent improves a ranking objective and keeps penalty signs", () => {
    // Relevance follows feature x; feature y is noise. nDCG-like objective: is the relevant item first?
    const items = [{ x: 1, y: 0, rel: 1 }, { x: 0, y: 1, rel: 0 }, { x: 0.2, y: 0.9, rel: 0 }];
    const objective = (w: Record<string, number>) => {
      const ranked = [...items].sort((a, b) => (w.x! * b.x + w.y! * b.y + w.q! * 0) - (w.x! * a.x + w.y! * a.y + w.q! * 0));
      return ranked[0]!.rel - 0.001 * Math.abs(w.q!);
    };
    const result = coordinateAscent({ x: 0.1, y: 1, q: -0.5 }, [{ name: "x" }, { name: "y" }, { name: "q", sign: -1 }], objective);
    expect(result.objective).toBeGreaterThan(result.initial);
    expect(result.values.x).toBeGreaterThan(result.values.y! * 0.2);
    expect(result.values.q).toBeLessThanOrEqual(0);
  });

  it("ranks prepared candidates with any weight vector (what the tuner evaluates)", () => {
    ingest("a", "Garden plan", "Tomatoes and basil.");
    ingest("b", "Basil pesto", "Basil, garlic, and pine nuts.");
    build();
    const prepared = prepareSearch(db, parseQuery(db, "basil", { now: NOW }), { now: NOW });
    expect(buildUnits(prepared.query).map(unit => unit.key)).toEqual(["term:basil"]);
    const titleOnly = { ...DEFAULT_SEARCH_WEIGHTS, bm25f: 0, coverage: 0, proximity: 0, recency: 0, involvement: 0, title: 1 };
    expect(rankPrepared(prepared, titleOnly).map(entry => entry.candidate.sourceId)[0]).toBe("b");
    expect(searchWeights(db, { title: 9, bogus: 3 }).title).toBe(9);
  });

  it("uses tuned weights from extension_state unless told not to", () => {
    db.query(`INSERT INTO extension_state(extension_id,state_key,value,updated_at) VALUES('knowledge-graph','search-weights',?,0)`)
      .run(JSON.stringify({ weights: { recency: 0.77 }, diversity: 0.9 }));
    expect(searchWeights(db).recency).toBe(0.77);
    expect(searchWeights(db, null, true).recency).toBe(DEFAULT_SEARCH_WEIGHTS.recency);
    expect(searchWeights(db, { recency: 0.1 }).recency).toBe(0.1);
  });
});

describe("integration and access control", () => {
  it("searchMemory keeps its hit shape on the engine and falls back to BM25 without an index", () => {
    ingest("note", "Orchid care", "Water orchids weekly and keep them out of direct sun.");
    classifyPending(db, { budgetMs: 5_000 });
    const before = searchMemory(db, { query: "orchids", ranker: "engine" });
    expect(before.ranker).toBe("bm25");
    indexSources(db);
    const after = searchMemory(db, { query: "orchids", ranker: "engine", explain: true });
    expect(after.ranker).toBe("engine");
    expect(Object.keys(after.hits[0]!).sort()).toEqual([...Object.keys(before.hits[0]!), "similar", "matched", "explain"].sort());
    expect(after.hits[0]).toMatchObject({ sourceId: "note", title: "Orchid care", memoryVersion: before.hits[0]!.memoryVersion });
    // The engine cites its best passage: the snippet holding the words rather than the summary.
    expect(after.hits[0]!.snippetVersionId ?? after.hits[0]!.summaryVersionId).not.toBeNull();
    expect(after.hits[0]!.preview).toContain("orchids");
    expect(after.totalSources).toBe(1);
  });

  it("a restricted profile's engine search cannot surface hidden sources, by text or by entity", () => {
    ingest("dm", "Direct messages", "Planning the ocelot sanctuary visit.", { origin: "discord", type: "chat_session", uri: "discord://channel/1" });
    ingest("note", "Garden note", "Planted basil and mint near the sanctuary path.");
    const ocelot = entity("Ocelot Sanctuary", "Project", "dm");
    build();
    expect(ids(searchSources(db, "ocelot sanctuary", { now: NOW }))).toEqual(["dm"]);
    expect(ids(searchSources(db, "sanctuary", { now: NOW })).sort()).toEqual(["dm", "note"]);
    const { read } = createScopedSDK("cloud", sdk);
    const scoped = searchSources(read.database, "ocelot sanctuary", { now: NOW, collapse: false });
    // Only the visible note's "sanctuary" matches; the hidden source and its entity stay out.
    expect(ids(scoped)).toEqual(["note"]);
    expect(scoped.query.entities.map(item => item.id)).not.toContain(ocelot);
    expect(ids(searchSources(read.database, "sanctuary", { now: NOW }))).toEqual(["note"]);
    expect(searchSources(read.database, "ocelot", { now: NOW }).length).toBe(0);
    expect(searchSources(read.database, "ocelt", { now: NOW }).length).toBe(0);
    expect(searchMemory(read.database, { query: "ocelot", ranker: "engine" }).hits).toEqual([]);
    expect(ids(searchMemory(read.database, { query: "basil", ranker: "engine" }).hits)).toEqual(["note"]);
  });

  it("search_graph uses the engine on request, seeds expansion with linked entities, and respects the profile", async () => {
    ingest("dm", "Direct messages", "Planning the ocelot sanctuary visit.", { origin: "discord", type: "chat_session", uri: "discord://channel/1" });
    ingest("note", "Sanctuary garden note", "Planted basil near the sanctuary path.");
    const ocelot = entity("Ocelot Sanctuary", "Project", "dm");
    const keeper = entity("Ravi Keeper", "Person", "dm");
    sdk.graph.claims.add({ subject: keeper, predicate: "WORKS_ON", object: ocelot, status: "accepted", confidence: 0.9 } as never);
    build();
    const running = await startMcpServer({ port: 0, host: "127.0.0.1", sdk, namespace: "knowledge" });
    const clients: Client[] = [];
    const connect = async (token?: string) => {
      const client = new Client({ name: "engine-test", version: "1.0.0" });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined));
      return async (args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name: "search_graph", arguments: args })).content as any)[0].text);
    };
    try {
      const local = await connect();
      const result = await local({ query: "ocelot sanctuary", ranker: "engine", explain: true });
      expect(result.ranker).toBe("engine");
      expect(result.hits.map((hit: any) => hit.sourceId)).toEqual(["dm"]);
      expect(result.hits[0].explain.bm25f).toBeGreaterThan(0);
      expect(result.entities.map((item: any) => item.id)).toEqual([ocelot]);
      expect(result.neighborhoods[0].entities.map((item: any) => item.id)).toEqual(expect.arrayContaining([ocelot, keeper]));
      const cloud = await connect(createToken("cloud").token);
      const scoped = await cloud({ query: "ocelot sanctuary", ranker: "engine" });
      expect(scoped.hits.map((hit: any) => hit.sourceId)).toEqual(["note"]);
      expect(scoped.entities).toEqual([]);
    } finally {
      for (const client of clients) await client.close();
      await running.close();
    }
  });
});
