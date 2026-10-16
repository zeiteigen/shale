import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionSDK, type ShaleSDK } from "../sdk";
import { closeScopedSDKs, createScopedSDK } from "../sdk/access";
import { createTestDatabase } from "./fixtures/database";
import { setLabel } from "../lib/access/schema";
import { classifyPending } from "../lib/access/classify";
import { indexSources, searchFields, searchSummary, trigramCandidates } from "../sdk/retrieval/indexer";
import { boilerplateKey, producerOf } from "../sdk/retrieval/boilerplate";

const directory = mkdtempSync(join(tmpdir(), "shale-search-index-"));
const policyPath = process.env.SHALE_ACCESS_PATH!;
let db: Database;
let sdk: ShaleSDK;
let counter = 0;

const POLICY = {
  defaultTier: "personal", unauthenticatedProfile: "local", originTiers: { discord: "private" }, tierRules: [],
  profiles: { local: { clearance: "secret" }, cloud: { clearance: "personal" } },
};

function ingest(id: string, origin: string, uri: string, title: string, text: string, version = "v1") {
  sdk.ingest.sourceAndChunks({ source: { id, uri, title, origin, type: "note", hash: `${id}-${version}` }, chunks: [{ text_content: text }] });
}

function entity(name: string, type: string, sourceId?: string, namespace = "knowledge") {
  const id = sdk.graph.entities.create({ name, type, namespace }).id;
  if (sourceId) db.query("INSERT OR IGNORE INTO source_entities VALUES(?,?)").run(sourceId, id);
  return id;
}

const ids = (hits: Array<{ sourceId: string }>) => hits.map(hit => hit.sourceId).sort();

beforeEach(() => {
  writeFileSync(policyPath, JSON.stringify(POLICY));
  db = createTestDatabase(join(directory, `search-${counter++}.db`));
  sdk = createExtensionSDK("search-test", { database: db, namespace: "knowledge" });
});

afterEach(() => { closeScopedSDKs(); db.close(); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("search index fields", () => {
  it("drops the extractive overview from summaries", () => {
    expect(searchSummary("A model summary.\n\nCoverage:\n• repeated snippet")).toBe("A model summary.");
    const extractive = `Extractive overview of T:\n• ${"word ".repeat(200)}`;
    expect(searchSummary(extractive).length).toBeLessThanOrEqual(400);
    expect(searchSummary(extractive)).not.toContain("Extractive overview");
  });

  it("indexes titles, entity names, and acronyms, but not self or connector records", () => {
    ingest("hpc", "obsidian", "file:///vault/hpc.md", "Cluster notes", "Booked GPU time on the cluster for the protein project.");
    entity("University of Waterloo High Performance Computing", "Organization", "hpc");
    const self = sdk.graph.entities.create({ name: "Me", type: "Person", namespace: "knowledge", stableId: "self" } as never).id;
    db.query("INSERT OR IGNORE INTO source_entities VALUES(?,?)").run("hpc", self);
    entity("Weekly chat with Zebulon", "ChatSession", "hpc", "email");
    classifyPending(db, { budgetMs: 5_000 });
    expect(indexSources(db).indexed).toBe(1);
    expect(ids(searchFields(db, '"uwhpc"'))).toEqual(["hpc"]);
    expect(ids(searchFields(db, '"cluster" "notes"', { fieldHits: true }))).toEqual(["hpc"]);
    expect(searchFields(db, '"cluster"', { fieldHits: true })[0]!.fieldHits).toContain("title");
    expect(searchFields(db, '"zebulon"')).toEqual([]);
    expect(ids(trigramCandidates(db, "waterlo"))).toEqual(["hpc"]);
    expect(ids(trigramCandidates(db, "watreloo"))).toEqual(["hpc"]);
  });

  it("strips lines a producer repeats across its sources", () => {
    expect(producerOf({ origin: "email", uri: "email://inbox/thread/1" }, "[10:37] Launchpad <hello@joinlaunchpad.com>: Subject: hi")).toBe("email:hello@joinlaunchpad.com");
    expect(producerOf({ origin: "browser", uri: "https://www.example.com/a" }, "")).toBe("host:example.com");
    expect(boilerplateKey("To unsubscribe, click https://x.com/u/123")).toBe("to unsubscribe, click <url>");
    for (let i = 0; i < 6; i++) ingest(`mail-${i}`, "email", `email://inbox/thread/${i}`, `Update ${i}`,
      `[10:0${i}] Launchpad <hello@joinlaunchpad.com>: Subject: Update ${i}\n\nTopic number ${i} is ${["quasar", "nebula", "pulsar", "comet", "meteor", "aurora"][i]}.\n\nTo unsubscribe from Launchpad notifications, click here`);
    const result = indexSources(db);
    expect(result.indexed).toBe(6);
    expect(result.removedLines).toBeGreaterThanOrEqual(6);
    expect(searchFields(db, '{body} : "unsubscribe"')).toEqual([]);
    expect(ids(searchFields(db, '{body} : "quasar"'))).toEqual(["mail-0"]);
  });

  it("reindexes changed sources and deletes removed ones", () => {
    ingest("a", "obsidian", "file:///vault/a.md", "Alpha", "first draft about tulips");
    ingest("b", "obsidian", "file:///vault/b.md", "Beta", "notes about ferns");
    expect(indexSources(db).indexed).toBe(2);
    expect(indexSources(db).indexed).toBe(0);
    ingest("a", "obsidian", "file:///vault/a.md", "Alpha", "second draft about orchids", "v2");
    expect(indexSources(db).indexed).toBe(1);
    expect(ids(searchFields(db, '"orchids"'))).toEqual(["a"]);
    expect(searchFields(db, '"tulips"')).toEqual([]);
    entity("Kew Gardens", "Place", "b");
    expect(indexSources(db).indexed).toBe(1);
    expect(ids(searchFields(db, '"kew"'))).toEqual(["b"]);
    db.query("DELETE FROM sources WHERE id='b'").run();
    expect(indexSources(db).deleted).toBe(1);
    expect(searchFields(db, '"ferns"')).toEqual([]);
    expect(db.query("SELECT count(*) AS n FROM search_doc_entities").get()).toEqual({ n: 0 });
  });
});

describe("search index access control", () => {
  it("never returns hidden sources or matches a visible source by a hidden entity's name", () => {
    ingest("dm", "discord", "discord://channel/1", "Direct messages", "Talked about the ocelot sanctuary plan.");
    ingest("note", "obsidian", "file:///vault/note.md", "Garden note", "Planted basil and mint today.");
    entity("Ocelot Sanctuary", "Project", "dm");
    const codename = entity("Project Nightjar", "Project", "note");
    classifyPending(db, { budgetMs: 5_000 });
    setLabel(db, "entity", String(codename), "manual", 2, { reason: "test" });
    indexSources(db);
    // Locally everything is searchable, but the private entity is not indexed for the personal-tier note.
    expect(ids(searchFields(db, '"ocelot"'))).toEqual(["dm"]);
    expect(searchFields(db, '"nightjar"')).toEqual([]);
    const { read } = createScopedSDK("cloud", sdk);
    expect(read.database.query("SELECT id FROM sources").all()).toEqual([{ id: "note" }]);
    expect(searchFields(read.database, '"ocelot"')).toEqual([]);
    expect(trigramCandidates(read.database, "ocelot")).toEqual([]);
    expect(trigramCandidates(read.database, "sanctuary")).toEqual([]);
    expect(ids(searchFields(read.database, '"basil"'))).toEqual(["note"]);
    expect(searchFields(read.database, '"nightjar"')).toEqual([]);
  });

  it("hides an old private revision's search document until the visible memory is reindexed", () => {
    ingest("note", "obsidian", "file:///vault/note.md", "Garden note", "Private password: hunter2. Ocelot sanctuary plan.");
    classifyPending(db, { budgetMs: 5_000 });
    const old = db.query<{ id: number }, []>("SELECT id FROM graph_source_revisions WHERE source_id='note'").get()!.id;
    indexSources(db);
    expect(ids(searchFields(db, '"ocelot"'))).toEqual(["note"]);
    ingest("note", "obsidian", "file:///vault/note.md", "Garden note", "Planted basil and mint today.", "v2");
    const access = createScopedSDK("cloud", sdk);
    expect(access.scoped!.isVisible("sources", "note")).toBe(true);
    expect(access.scoped!.isVisible("revisions", old)).toBe(false);
    expect(access.read.database.query("SELECT * FROM search_docs").all()).toEqual([]);
    expect(searchFields(access.read.database, '"ocelot"')).toEqual([]);
    expect(trigramCandidates(access.read.database, "ocelot")).toEqual([]);
    indexSources(db);
    access.refresh();
    expect(ids(searchFields(access.read.database, '"basil"'))).toEqual(["note"]);
    expect(searchFields(access.read.database, '"ocelot"')).toEqual([]);
  });

  it("hides a stale document whose indexed entity became invisible", () => {
    ingest("note", "obsidian", "file:///vault/note.md", "Garden note", "Planted basil and mint today.");
    const heron = entity("Heron Initiative", "Project", "note");
    classifyPending(db, { budgetMs: 5_000 });
    indexSources(db);
    expect(ids(searchFields(db, '"heron"'))).toEqual(["note"]);
    // Raised after indexing: until the reindex the search_docs filter hides the document from the profile.
    setLabel(db, "entity", String(heron), "manual", 3, { reason: "test" });
    const { read } = createScopedSDK("cloud", sdk);
    expect(searchFields(read.database, '"heron"')).toEqual([]);
    expect(searchFields(read.database, '"basil"')).toEqual([]);
    indexSources(db);
    const scoped = createScopedSDK("cloud", sdk);
    expect(searchFields(scoped.read.database, '"heron"')).toEqual([]);
    expect(ids(searchFields(scoped.read.database, '"basil"'))).toEqual(["note"]);
  });
});
