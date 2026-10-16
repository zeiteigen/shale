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
import { buildSpeller, editDistance, parseQuery, queryTokens } from "../sdk/retrieval/query";

const directory = mkdtempSync(join(tmpdir(), "shale-search-query-"));
const policyPath = process.env.SHALE_ACCESS_PATH!;
const NOW = Date.UTC(2026, 9, 15, 12);
const DAY = 86_400_000;
let db: Database;
let sdk: ShaleSDK;
let counter = 0;

function ingest(id: string, title: string, text: string, origin = "obsidian") {
  sdk.ingest.sourceAndChunks({ source: { id, uri: `file:///vault/${id}.md`, title, origin, type: "note", hash: `${id}-v1` }, chunks: [{ text_content: text }] });
}

beforeEach(() => {
  writeFileSync(policyPath, JSON.stringify({ defaultTier: "personal", unauthenticatedProfile: "local", originTiers: {}, tierRules: [],
    profiles: { local: { clearance: "secret" }, cloud: { clearance: "personal" } } }));
  db = createTestDatabase(join(directory, `query-${counter++}.db`));
  sdk = createExtensionSDK("search-query-test", { database: db, namespace: "knowledge" });
});
afterEach(() => { closeScopedSDKs(); db.close(); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function corpus() {
  for (let i = 0; i < 6; i++) ingest(`w${i}`, `Waterloo update ${i}`, `The waterloo campus newsletter number ${i} mentions the library and the gym.`);
  ingest("kepler", "Planetary motion", "Kepler's laws describe orbits as ellipses.");
  const hpc = sdk.graph.entities.create({ name: "University of Waterloo High Performance Computing", type: "Organization", namespace: "knowledge" }).id;
  sdk.graph.entities.addAlias(hpc, "uwhpc", "key:acronym");
  indexEntity(db, hpc);
  db.query("INSERT OR IGNORE INTO source_entities VALUES(?,?)").run("w0", hpc);
  classifyPending(db, { budgetMs: 5_000 });
  refreshPhraseDictionary(db, { force: true });
  indexSources(db);
  return { hpc };
}

describe("query syntax", () => {
  it("tokenises words, keeps hyphenated terms whole, and drops possessives", () => {
    expect(queryTokens("Kepler's llama-swap I-20").map(token => token.text)).toEqual(["kepler", "llama-swap", "i-20"]);
  });

  it("reads quoted phrases and operators", () => {
    corpus();
    const parsed = parseQuery(db, '"campus newsletter" from:nasser origin:email type:chat_session source:abc after:2025-01 before:2026-02-01', { now: NOW });
    expect(parsed.phrases).toContainEqual({ text: "campus newsletter", quoted: true });
    expect(parsed.filters).toMatchObject({ from: "nasser", origin: "email", type: "chat_session", sourceId: "abc" });
    expect(parsed.dateRange!.start).toBe(Date.UTC(2025, 1, 1));
    expect(parsed.dateRange!.end).toBe(Date.UTC(2026, 1, 1) - 1);
    expect(parsed.filters.after).toBe(Date.UTC(2025, 1, 1));
    expect(parsed.terms.map(term => term.text)).toEqual(["campus", "newsletter"]);
  });

  it("turns relative wording into a date range and deadline wording into future intent", () => {
    corpus();
    const week = parseQuery(db, "library notes from last week", { now: NOW });
    expect(week.dateRange).toEqual({ start: NOW - 7 * DAY, end: NOW });
    expect(week.intent).toBe("temporal");
    expect(week.terms.map(term => term.text)).toEqual(["library", "notes"]);
    const june = parseQuery(db, "gym in June", { now: NOW });
    expect(june.dateRange).toEqual({ start: Date.UTC(2026, 5, 1), end: Date.UTC(2026, 6, 1) - 1 });
    expect(parseQuery(db, "upcoming deadline", { now: NOW }).future).toBe(true);
    // A written-out date is part of what is searched for (a subject line), not a filter.
    const subject = parseQuery(db, "Deadline today: April 19th winners", { now: NOW });
    expect(subject.dateRange).toBeUndefined();
    expect(subject.terms.map(term => term.text)).toContain("april");
  });
});

describe("weights, corrections, and entities", () => {
  it("weights terms by IDF and makes very common terms optional", () => {
    corpus();
    const parsed = parseQuery(db, "waterloo kepler", { now: NOW });
    const waterloo = parsed.terms.find(term => term.text === "waterloo")!, kepler = parsed.terms.find(term => term.text === "kepler")!;
    expect(waterloo.optional).toBe(true);
    expect(kepler.optional).toBe(false);
    expect(kepler.weight).toBeGreaterThan(waterloo.weight);
    // Every content term optional: the content words become required again.
    expect(parseQuery(db, "waterloo", { now: NOW }).terms[0]!.optional).toBe(false);
  });

  it("corrects unknown words towards the index vocabulary, but not acronyms or known words", () => {
    corpus();
    expect(parseQuery(db, "waterlo", { now: NOW }).terms[0]).toMatchObject({ text: "waterlo", corrected: "waterloo" });
    expect(parseQuery(db, "watreloo campus", { now: NOW }).terms[0]!.corrected).toBe("waterloo");
    expect(parseQuery(db, "campus", { now: NOW }).terms[0]!.corrected).toBeUndefined();
    expect(parseQuery(db, "WATRELOO", { now: NOW }).terms[0]!.corrected).toBeUndefined();
  });

  it("links registry entities by acronym and by name, with expansions both ways", () => {
    const { hpc } = corpus();
    const acronym = parseQuery(db, "uwhpc", { now: NOW });
    expect(acronym.entities.map(entity => entity.id)).toEqual([hpc]);
    expect(acronym.entities[0]!.expansions).toContain("University of Waterloo High Performance Computing");
    expect(acronym.intent).toBe("navigational");
    const name = parseQuery(db, "university of waterloo high performance computing", { now: NOW });
    expect(name.entities.map(entity => entity.id)).toEqual([hpc]);
    expect(name.entities[0]!.expansions).toContain("UWHPC");
    expect(name.entities[0]!.weight).toBeGreaterThan(0);
  });

  it("is fast and runs on a scoped read-only connection", () => {
    corpus();
    parseQuery(db, "warm up waterlo", { now: NOW });
    const started = performance.now();
    for (let i = 0; i < 20; i++) parseQuery(db, `kepler orbits uwhpc ${i}`, { now: NOW });
    expect((performance.now() - started) / 20).toBeLessThan(50);
    const { read } = createScopedSDK("cloud", sdk);
    const scoped = parseQuery(read.database, "uwhpc kepler", { now: NOW });
    expect(scoped.terms.map(term => term.text)).toEqual(["uwhpc", "kepler"]);
    // Visible registry entities still link (the gazetteer reads through the profile's views).
    expect(scoped.entities.map(entity => entity.name)).toEqual(["University of Waterloo High Performance Computing"]);
  });
});

describe("spelling primitives", () => {
  it("measures optimal string alignment distance with transpositions", () => {
    expect(editDistance("waterloo", "watreloo")).toBe(1);
    expect(editDistance("waterlo", "waterloo")).toBe(1);
    expect(editDistance("kitten", "sitting", 5)).toBe(3);
    expect(editDistance("abc", "abcdef", 2)).toBe(3);
  });

  it("suggests the closest, most frequent vocabulary word", () => {
    const speller = buildSpeller([["waterloo", 50], ["waterlog", 3], ["calendar", 20]]);
    expect(speller.suggest("waterlo")).toMatchObject({ word: "waterloo", distance: 1 });
    expect(speller.suggest("calnedar")?.word).toBe("calendar");
    expect(speller.suggest("zzzz")).toBeNull();
  });
});
