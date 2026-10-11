import { afterEach, expect, it } from "bun:test";
import { createExtensionSDK, runWithSDK, search, searchBM25, searchChunks, extractKeywords, DEFAULT_STOP_WORDS } from "../sdk";
import { createTestDatabase } from "./fixtures/database";

const databases: ReturnType<typeof createTestDatabase>[] = [];
function fixture() {
  const db = createTestDatabase();
  databases.push(db);
  const sdk = createExtensionSDK("test-search", { database: db });
  const insert = (uri: string, title: string, chunks: Array<{ text_content: string; chunk_type?: "verbatim" | "synthetic" }>) =>
    sdk.ingest.sourceAndChunks({
      source: { type: "doc", uri, origin: "test", title }, chunks,
    });
  insert("file:///docs/tech.md", "Technical Architecture", [
    { text_content: "Bun is a fast all-in-one JavaScript and TypeScript runtime built for modern web development." },
    { text_content: "SQLite is a C-language library that implements a small, fast, self-contained SQL database engine." },
    { text_content: "Shale combines Bun runtime and SQLite database to deliver high performance text search." },
    { text_content: "Direct code quotation describes cryptographic hashing with exact SHA256 output.", chunk_type: "verbatim" },
    { text_content: "AI summary and conceptual expansion: High level overview of cryptographic hashing algorithms.", chunk_type: "synthetic" },
  ]);
  insert("file:///docs/science.md", "Scientific Principles", [
    { text_content: "Quantum computing utilizes quantum superposition and entanglement to perform complex state calculations." },
    { text_content: "Entanglement in quantum physics enables correlated states across atomic distances and quantum networks." },
  ]);
  return { db, sdk };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

it("extracts unique keywords and removes stopwords with supported options", () => {
  const keywords = extractKeywords("The architecture and performance of SQLite and Bun runtime in web systems");
  expect(keywords).toContain("architecture");
  expect(keywords).toContain("sqlite");
  expect(keywords).not.toContain("the");
  expect(extractKeywords("The state of the art", { keepStopWords: true })).toContain("the");
  expect(extractKeywords("React and Vue with Vite bundler", { stopWords: ["react", "vue", "and", "with"] })).toEqual(["vite", "bundler"]);
  expect(extractKeywords("To be or not to be")).toContain("to");
  expect(DEFAULT_STOP_WORDS.has("and")).toBe(true);
});

it("searches with BM25, returning matched chunks, snippets, and scores", async () => {
  const { sdk } = fixture();
  const results = await sdk.search.bm25({ query: "SQLite", limit: 5 });
  expect(results).toHaveLength(3);
  expect(results.some(result => result.chunk_index === 0 && result.text_content.startsWith("Extractive overview"))).toBe(true);
  expect(results.map(result => result.text_content).join(" ")).toContain("database");
  expect(results[0].bm25Score).toBeDefined();
  expect(results[0].preview).toContain("<mark>");
  expect(results[0].matchedKeywords).toContain("sqlite");
});

it("fuses per-keyword matches and supports alternate BM25 fusion strategies", async () => {
  const { sdk } = fixture();
  const results = await sdk.search.bm25({ query: "Bun and SQLite", keywordFusion: "rrf" });
  expect(results[0].text_content).toContain("Shale combines");
  expect(results[0].matchedKeywords).toEqual(expect.arrayContaining(["bun", "sqlite"]));
  expect((await sdk.search.bm25({ query: "quantum entanglement and physics", keywordFusion: "sum_scores" })).length).toBeGreaterThan(0);
  expect((await sdk.search.bm25({ query: "quantum physics", keywordFusion: "disjunctive" })).length).toBeGreaterThan(0);
});

it("filters BM25 results by source and chunk type", async () => {
  const { sdk } = fixture();
  const scoped = await sdk.search.bm25({ query: "runtime database", filterSourceId: "file:///docs/tech.md" });
  expect(scoped.length).toBeGreaterThan(0);
  expect(scoped.every(result => result.source_uri === "file:///docs/tech.md")).toBe(true);
  const verbatim = await sdk.search.bm25({ query: "cryptographic hashing", filterChunkType: "verbatim" });
  const synthetic = await sdk.search.bm25({ query: "cryptographic hashing", filterChunkType: "synthetic" });
  expect(verbatim.every(result => result.chunk_type === "verbatim")).toBe(true);
  expect(verbatim[0].text_content).toContain("Direct code quotation");
  expect(synthetic.every(result => result.chunk_type === "synthetic")).toBe(true);
  expect(synthetic[0].text_content).toContain("AI summary");
});

it("exposes BM25 query and convenience methods through the scoped SDK", async () => {
  const { sdk } = fixture();
  expect((await sdk.search.query({ mode: "bm25", query: "Quantum superposition" })).length).toBeGreaterThan(0);
  await runWithSDK(sdk, async () => {
    expect((await search.bm25({ query: "Bun TypeScript", limit: 1 }))[0].text_content).toContain("Bun");
    expect((await searchBM25({ query: "quantum entanglement", limit: 1 }))[0].matchedKeywords).toContain("entanglement");
    expect((await searchChunks({ mode: "bm25", query: "SQLite database", limit: 1 }))[0].text_content).toContain("SQLite");
  });
  await expect(sdk.search.query({ mode: "unsupported" } as any)).rejects.toThrow("Unsupported search mode");
});
