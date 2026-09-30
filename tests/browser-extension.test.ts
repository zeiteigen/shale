import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { join } from "node:path";
import { isTExtensionManifest, type ExtensionManifest } from "../lib/extension";
import { createExtensionSDK, type ShaleSDK, createMessageBus, MessageBus } from "../sdk";
import {
  evaluateUrl,
  matchesExcludeDomains,
  matchesExcludePatterns,
  normalizeUrl,
} from "../extensions/browser/filter";
import {
  analyzePageWithLLM,
  buildFallbackPageAnalysis,
  buildFallbackSessionAnalysis,
  parseLLMJson,
  synthesizeSessionWithLLM,
} from "../extensions/browser/llm-enricher";
import {
  chunkText,
  processBookmarksBatch,
  processHistoryBatch,
  processPageVisit,
  processTabsBatch,
} from "../extensions/browser/ingest-processor";
import {
  buildSequentialEdges,
  commitSessionToGraph,
  finalizeActiveSession,
  getActiveSession,
  ingestSessionSnapshot,
  recordSessionVisit,
  setActiveSession,
} from "../extensions/browser/session-manager";
import { run as runRecover } from "../extensions/browser/recover";
import { run as runCron } from "../extensions/browser/index";
import { subscribe } from "../extensions/browser/subscribe";
import type { TabsBatchPayload } from "../extensions/browser/types";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  sqliteVec.load(db);

  // Sources
  db.run(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      uri TEXT NOT NULL,
      origin TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      title TEXT NOT NULL,
      updated_at INT NOT NULL,
      hash TEXT NOT NULL
    ) STRICT;
  `);

  // Chunks
  db.run(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      source_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text_content TEXT NOT NULL,
      chunk_type TEXT NOT NULL DEFAULT 'verbatim' CHECK(chunk_type IN ('verbatim', 'synthetic')),
      FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE CASCADE
    ) STRICT;
  `);

  // Vector index
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vector_index USING vec0(
      embedding float[4096]
    );
  `);

  // FTS5
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text_content, 
      content='chunks', 
      content_rowid='id', 
      tokenize='porter'
    );
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text_content) VALUES (new.id, new.text_content);
    END;
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text_content) VALUES ('delete', old.id, old.text_content);
    END;
  `);

  // Extension state
  db.run(`
    CREATE TABLE IF NOT EXISTS extension_state (
      extension_id TEXT NOT NULL,
      state_key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (extension_id, state_key)
    ) STRICT;
  `);

  // Checkpoints
  db.run(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      extension_id TEXT NOT NULL,
      checkpoint_key TEXT NOT NULL DEFAULT 'default',
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
    ) STRICT;
  `);

  // Entities
  db.run(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY,
      namespace TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      UNIQUE (namespace, name)
    ) STRICT;
  `);

  // Edges
  db.run(`
    CREATE TABLE IF NOT EXISTS edges (
      source_entity_id INTEGER NOT NULL,
      target_entity_id INTEGER NOT NULL,
      relation TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      metadata TEXT,
      PRIMARY KEY (source_entity_id, target_entity_id, relation),
      FOREIGN KEY(source_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY(target_entity_id) REFERENCES entities(id) ON DELETE CASCADE
    ) STRICT;
  `);

  // Chunk Entities
  db.run(`
    CREATE TABLE IF NOT EXISTS chunk_entities (
      chunk_id INTEGER NOT NULL,
      entity_id INTEGER NOT NULL,
      PRIMARY KEY (chunk_id, entity_id),
      FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
      FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE
    ) STRICT;
  `);

  return db;
}

function createMockEmbedder() {
  const dummyVec = new Array(4096).fill(0.01);
  return {
    embed: async (input: string | string[]) => {
      if (Array.isArray(input)) {
        return input.map(() => [...dummyVec]);
      }
      return [...dummyVec];
    },
  } as any;
}

function createMockLLM(responseGenerator?: (prompt: string) => string) {
  return {
    query: async (prompt: any) => {
      const text = typeof prompt === "string" ? prompt : prompt.prompt;
      if (responseGenerator) {
        return responseGenerator(text);
      }
      if (text.includes("single browsing session")) {
        return JSON.stringify({
          sessionTitle: "Researching SQLite Vector Extensions in Bun",
          summary:
            "Explored sqlite-vec and Bun documentation to integrate vector search into SQLite.",
          topics: ["SQLite", "Vector Search", "Bun"],
          dominantDomains: ["bun.sh", "github.com"],
        });
      }
      return JSON.stringify({
        summary:
          "Documentation covering SQLite full-text search with FTS5 and trigram tokenizers.",
        topics: ["SQLite", "FTS5", "Search"],
        category: "Documentation",
      });
    },
  } as any;
}

describe("Browser Ingestion Extension", () => {
  let testDb: Database;
  let testSdk: ShaleSDK;
  let testBus: MessageBus;

  beforeEach(() => {
    testDb = createTestDb();
    testBus = createMessageBus();
    testSdk = createExtensionSDK(
      "browser",
      "browser",
      testDb,
      undefined,
      undefined,
      undefined,
      join(import.meta.dir, "../extensions/browser"),
      testBus,
    );

    const dummyVec = new Array(4096).fill(0.01);
    (testSdk as any).embed = async (input: string | string[]) => {
      if (Array.isArray(input)) {
        return input.map(() => [...dummyVec]);
      }
      return [...dummyVec];
    };

    (testSdk as any).queryLLM = async (prompt: any) => {
      const text = typeof prompt === "string" ? prompt : prompt.prompt;
      if (text.includes("single browsing session")) {
        return JSON.stringify({
          sessionTitle: "Researching SQLite Vector Extensions in Bun",
          summary:
            "Explored sqlite-vec and Bun documentation to integrate vector search into SQLite.",
          topics: ["SQLite", "Vector Search", "Bun"],
          dominantDomains: ["bun.sh", "github.com"],
        });
      }
      return JSON.stringify({
        summary:
          "Documentation covering SQLite full-text search with FTS5 and trigram tokenizers.",
        topics: ["SQLite", "FTS5", "Search"],
        category: "Documentation",
      });
    };
  });

  describe("1. Manifest & Configuration", () => {
    it("has a valid manifest.json complying with ExtensionManifest", async () => {
      const manifestPath = join(
        import.meta.dir,
        "../extensions/browser/manifest.json",
      );
      const manifest = await Bun.file(manifestPath).json();

      expect(isTExtensionManifest(manifest)).toBe(true);
      expect(manifest.name).toBe("browser");
      expect(manifest.namespace).toBe("browser");
      expect(manifest.subscribe_ingest).toBe("subscribe.ts");
      expect(manifest.checkpoint_recover).toBe("recover.ts");
      expect(manifest.crons).toBeDefined();
      expect(manifest.crons.length).toBeGreaterThan(0);
      expect(manifest.crons[0].script).toBe("index.ts");
    });

    it("has valid settings.json and settings.help.json schemas", async () => {
      const settingsPath = join(
        import.meta.dir,
        "../extensions/browser/settings.json",
      );
      const helpPath = join(
        import.meta.dir,
        "../extensions/browser/settings.help.json",
      );

      const settings = await Bun.file(settingsPath).json();
      const help = await Bun.file(helpPath).json();

      expect(Array.isArray(settings.excludeDomains)).toBe(true);
      expect(settings.excludeDomains).toContain("x.com");
      expect(settings.excludeDomains).toContain("reddit.com");
      expect(settings.excludeDomains).toContain("instagram.com");

      expect(Array.isArray(settings.excludePatterns)).toBe(true);
      expect(settings.excludePatterns).toContain("*mail.google.com*");

      expect(typeof settings.sessionInactivityMinutes).toBe("number");
      expect(typeof settings.enableLlmAnalysis).toBe("boolean");
      expect(settings.generateSessionSummaries).toBe(true);

      expect(help.extension).toBe("browser");
      expect(help.settings.excludeDomains).toBeDefined();
      expect(help.settings.sessionInactivityMinutes.range).toBeDefined();
    });
  });

  describe("2. URL Normalization & Exclusion Filter Engine", () => {
    it("normalizes URLs and strips tracking parameters", () => {
      const raw =
        "https://example.com/docs/api?utm_source=twitter&utm_medium=social&fbclid=12345&id=42#overview";
      const norm = normalizeUrl(raw);

      expect(norm.isValid).toBe(true);
      expect(norm.cleanUrl).toBe("https://example.com/docs/api?id=42");
      expect(norm.domain).toBe("example.com");
      expect(norm.pathname).toBe("/docs/api");
    });

    it("excludes social media platforms to avoid collision", () => {
      const domains = [
        "x.com",
        "twitter.com",
        "reddit.com",
        "facebook.com",
        "instagram.com",
      ];

      expect(matchesExcludeDomains("reddit.com", domains)).toBe(true);
      expect(matchesExcludeDomains("sub.reddit.com", domains)).toBe(true);
      expect(matchesExcludeDomains("x.com", domains)).toBe(true);
      expect(matchesExcludeDomains("instagram.com", domains)).toBe(true);
      expect(matchesExcludeDomains("github.com", domains)).toBe(false);
      expect(matchesExcludeDomains("bun.sh", domains)).toBe(false);
    });

    it("evaluates wildcard exclusion patterns for sensitive sites", () => {
      const patterns = ["*mail.google.com*", "*accounts.google.com*", "*bank*"];

      expect(
        matchesExcludePatterns("https://mail.google.com/mail/u/0", patterns),
      ).toBe(true);
      expect(
        matchesExcludePatterns("https://accounts.google.com/signin", patterns),
      ).toBe(true);
      expect(
        matchesExcludePatterns("https://mybank.com/dashboard", patterns),
      ).toBe(true);
      expect(
        matchesExcludePatterns("https://sqlite.org/fts5.html", patterns),
      ).toBe(false);
    });

    it("filters full URLs based on settings", () => {
      const settings: Partial<BrowserExtensionSettings> = {
        excludeDomains: ["x.com", "reddit.com"],
        excludePatterns: ["*mail.google.com*", "*login*"],
      };

      const res1 = evaluateUrl("https://reddit.com/r/programming", settings);
      expect(res1.allowed).toBe(false);
      expect(res1.reason).toContain("excludeDomains");

      const res2 = evaluateUrl(
        "https://mail.google.com/mail/u/0/#inbox",
        settings,
      );
      expect(res2.allowed).toBe(false);
      expect(res2.reason).toContain("excludePatterns");

      const res3 = evaluateUrl("chrome://extensions", settings);
      expect(res3.allowed).toBe(false);
      expect(res3.reason).toContain("Unsupported protocol");

      const res4 = evaluateUrl(
        "https://bun.sh/docs/runtime/bun-apis?utm_source=docs",
        settings,
      );
      expect(res4.allowed).toBe(true);
      expect(res4.cleanUrl).toBe("https://bun.sh/docs/runtime/bun-apis");
      expect(res4.domain).toBe("bun.sh");
    });
  });

  describe("3. LLM Analysis & JSON Parsing", () => {
    it("parses raw JSON and markdown code fences", () => {
      const rawJson = '{"summary": "Test", "topics": ["A", "B"]}';
      expect(parseLLMJson(rawJson, {})).toEqual({
        summary: "Test",
        topics: ["A", "B"],
      });

      const fencedJson = '```json\n{"summary": "Fenced", "topics": ["C"]}\n```';
      expect(parseLLMJson(fencedJson, {})).toEqual({
        summary: "Fenced",
        topics: ["C"],
      });

      const invalid = "NOT_JSON";
      expect(parseLLMJson(invalid, { fallback: true })).toEqual({
        fallback: true,
      });
    });

    it("generates fallback analysis when LLM is unavailable or content is short", () => {
      const fb = buildFallbackPageAnalysis(
        "SQLite Vector Guide",
        "sqlite.org",
        "Short excerpt",
      );
      expect(fb.summary).toBe("Short excerpt");
      expect(fb.category).toBe("WebPage");
      expect(fb.topics).toEqual(["SQLite Vector Guide"]);

      const sfb = buildFallbackSessionAnalysis([
        {
          url: "https://bun.sh",
          title: "Bun",
          domain: "bun.sh",
          visitedAt: 1000,
        },
      ]);
      expect(sfb.sessionTitle).toContain("Bun");
      expect(sfb.dominantDomains).toContain("bun.sh");
    });

    it("analyzes web page with LLM producing summary, topics, and category", async () => {
      const page = {
        url: "https://sqlite.org/fts5.html",
        cleanUrl: "https://sqlite.org/fts5.html",
        domain: "sqlite.org",
        title: "SQLite FTS5 Extension",
        textContent:
          "The FTS5 extension provides full-text search capability for SQLite tables. It supports BM25 ranking and tokenizers.",
        excerpt: "FTS5 provides full text search for SQLite.",
        visitedAt: Date.now(),
      };

      const res = await analyzePageWithLLM(testSdk, page, {
        minContentLength: 50,
      });
      expect(res.summary).toBeDefined();
      expect(res.topics).toContain("SQLite");
      expect(res.topics).toContain("FTS5");
      expect(res.category).toBe("Documentation");
    });

    it("synthesizes multi-page session into high-level title and narrative", async () => {
      const visits = [
        {
          url: "https://bun.sh/docs",
          title: "Bun Documentation",
          domain: "bun.sh",
          visitedAt: 1000,
          transitionType: "typed",
        },
        {
          url: "https://github.com/asg017/sqlite-vec",
          title: "sqlite-vec Repository",
          domain: "github.com",
          visitedAt: 2000,
          transitionType: "link",
        },
      ];

      const synthesis = await synthesizeSessionWithLLM(testSdk, visits, {});
      expect(synthesis.sessionTitle).toContain("SQLite Vector");
      expect(synthesis.summary).toContain("sqlite-vec");
      expect(synthesis.topics).toContain("Vector Search");
      expect(synthesis.dominantDomains).toContain("bun.sh");
    });
  });

  describe("4. Text Chunking", () => {
    it("splits long text cleanly on paragraphs and sentence boundaries", () => {
      const text = [
        "Paragraph one is introducing the subject.",
        "Paragraph two provides in-depth technical analysis of SQLite virtual tables and vector indexing.",
        "Paragraph three wraps up the findings with recommendations for production deployments.",
      ].join("\n\n");

      const chunks = chunkText(text, 100);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeGreaterThan(0);
        expect(chunk.length).toBeLessThanOrEqual(100);
      }
    });

    it("hard-limits punctuation-free DOM text", () => {
      const chunks = chunkText(`prefix ${"x".repeat(250)} suffix`, 80);
      expect(chunks.length).toBeGreaterThan(3);
      expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true);
    });
  });

  describe("5. Active Web Page Ingestion & Graph Creation", () => {
    it("ingests a page visit, commits sources/chunks, and creates graph entities and edges", async () => {
      const payload = {
        type: "page_visit" as const,
        url: "https://bun.sh/docs/api/sqlite?utm_source=test",
        title: "Bun SQLite Documentation",
        textContent:
          "Bun provides high performance native SQLite bindings with support for custom extensions, WAL mode, and fast statement caching.",
        excerpt: "Native SQLite bindings in Bun.",
        visitedAt: 1700000000000,
      };

      const res = await processPageVisit(testSdk, payload, {});
      expect(res).not.toBeNull();
      expect(res!.summary).toBeDefined();
      expect(res!.topics).toBeDefined();

      // Verify sources table
      const source = testDb
        .query<any, any>("SELECT * FROM sources WHERE uri = ?")
        .get("https://bun.sh/docs/api/sqlite");
      expect(source).toBeDefined();
      expect(source.title).toBe("Bun SQLite Documentation");
      expect(source.type).toBe("web_page");
      expect(source.origin).toBe("browser");

      // Verify chunks table
      const chunks = testDb
        .query<any, any>("SELECT * FROM chunks WHERE source_id = ? ORDER BY chunk_index ASC")
        .all(source.id);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0].chunk_type).toBe("synthetic");
      if (chunks.length > 1) {
        expect(chunks[1].chunk_type).toBe("verbatim");
      }

      // Verify vector index
      const vecCount = testDb
        .query<any, any>("SELECT count(*) as count FROM vector_index")
        .get();
      expect(vecCount.count).toBeGreaterThanOrEqual(1);

      // Verify FTS5 search
      const ftsRes = testDb
        .query<any, any>(
          "SELECT * FROM chunks_fts WHERE chunks_fts MATCH 'sqlite'",
        )
        .all();
      expect(ftsRes.length).toBeGreaterThanOrEqual(1);

      // Verify Graph entities
      const entities = testDb
        .query<any, any>("SELECT * FROM entities WHERE namespace = 'browser'")
        .all();
      const entityNames = entities.map((e) => e.name);
      expect(entityNames).toContain("https://bun.sh/docs/api/sqlite");
      expect(entityNames).toContain("bun.sh");
      expect(entities.find((entity) => entity.name === "bun.sh")?.type).toBe("Domain");

      // Verify Graph edges
      const edges = testDb.query<any, any>("SELECT * FROM edges").all();
      expect(edges.length).toBeGreaterThan(0);
      const edgeRelations = edges.map((e) => e.relation);
      expect(edgeRelations).toContain("BELONGS_TO_DOMAIN");
    });

    it("keeps same-titled pages distinct and rejects low-quality topic nodes", async () => {
      (testSdk as any).queryLLM = async () => JSON.stringify({
        summary: "Two separate pages.",
        topics: ["of", "from", "example.com", "Useful Concept"],
        category: "Article",
      });
      for (const url of ["https://example.com/one", "https://example.com/two"]) {
        await processPageVisit(testSdk, {
          type: "page_visit",
          url,
          title: "Shared title",
          textContent: "Enough page content to pass the analysis threshold and exercise stable graph identities.",
          recordInSession: false,
        }, { enableLlmAnalysis: true, minContentLength: 20 });
      }

      const pages = testDb.query<any, any>(
        "SELECT name FROM entities WHERE namespace = 'browser' AND type = 'WebPage' ORDER BY name",
      ).all();
      expect(pages.map((page) => page.name)).toEqual([
        "https://example.com/one",
        "https://example.com/two",
      ]);
      const topics = testDb.query<any, any>(
        "SELECT name FROM entities WHERE namespace = 'browser' AND type = 'Topic'",
      ).all().map((topic) => topic.name);
      expect(topics).toEqual(["Useful Concept"]);
    });

    it("skips excluded domains without writing to DB", async () => {
      const payload = {
        type: "page_visit" as const,
        url: "https://x.com/someone/status/12345",
        title: "Post on X",
        textContent: "Social media post content",
      };

      const res = await processPageVisit(testSdk, payload, {
        excludeDomains: ["x.com"],
      });
      expect(res).toBeNull();

      const source = testDb
        .query<any, any>("SELECT * FROM sources WHERE uri LIKE '%x.com%'")
        .get();
      expect(source).toBeNull();
    });
  });

  describe("6. Explicit Web Session Grouping", () => {
    it("clusters sequential page visits into a session with NAVIGATED_TO links", async () => {
      setActiveSession(testSdk, null);

      const v1 = {
        url: "https://bun.sh/docs",
        title: "Bun Docs",
        domain: "bun.sh",
        visitedAt: 1000,
        transitionType: "typed",
      };
      const r1 = await recordSessionVisit(testSdk, v1, "session-1", {
        sessionInactivityMinutes: 30,
      });
      expect(r1.activeSession.sessionId).toBe("session-1");
      expect(r1.activeSession.visits.length).toBe(1);

      const v2 = {
        url: "https://bun.sh/docs/api/sqlite",
        title: "Bun SQLite",
        domain: "bun.sh",
        visitedAt: 2000,
        transitionType: "link",
      };
      const r2 = await recordSessionVisit(testSdk, v2, "session-1", {
        sessionInactivityMinutes: 30,
      });
      expect(r2.activeSession.visits.length).toBe(2);
      expect(r2.sequentialEdge).toEqual({
        source: "https://bun.sh/docs",
        target: "https://bun.sh/docs/api/sqlite",
      });

      // Verify buildSequentialEdges
      const seqEdges = buildSequentialEdges(r2.activeSession.visits);
      expect(seqEdges.length).toBe(1);
      expect(seqEdges[0].relation).toBe("NAVIGATED_TO");
      expect(seqEdges[0].source).toBe("https://bun.sh/docs");
      expect(seqEdges[0].target).toBe("https://bun.sh/docs/api/sqlite");
    });

    it("does not invent navigation edges across unrelated tabs", async () => {
      const visits = [
        { url: "https://one.example", title: "One", domain: "one.example", visitedAt: 1, tabId: 10 },
        { url: "https://two.example", title: "Two", domain: "two.example", visitedAt: 2, tabId: 20 },
      ];
      expect(buildSequentialEdges(visits)).toEqual([]);

      setActiveSession(testSdk, null);
      await recordSessionVisit(testSdk, visits[0], "tabs", {});
      const result = await recordSessionVisit(testSdk, visits[1], "tabs", {});
      expect(result.sequentialEdge).toBeUndefined();
    });

    it("finalizes and commits session into WebSession entity and CONTAINS_PAGE edges", async () => {
      setActiveSession(testSdk, null);

      await recordSessionVisit(
        testSdk,
        {
          url: "https://bun.sh",
          title: "Bun Runtime",
          domain: "bun.sh",
          visitedAt: 1000,
        },
        "session-test-commit",
      );

      await recordSessionVisit(
        testSdk,
        {
          url: "https://github.com/asg017/sqlite-vec",
          title: "sqlite-vec",
          domain: "github.com",
          visitedAt: 2000,
        },
        "session-test-commit",
      );

      const sessionResult = await finalizeActiveSession(testSdk, {});
      expect(sessionResult).not.toBeNull();
      expect(sessionResult!.sessionId).toBe("session-test-commit");
      expect(sessionResult!.pageCount).toBe(2);

      // Verify WebSession source
      const sessionSource = testDb
        .query<any, any>("SELECT * FROM sources WHERE type = 'web_session'")
        .get();
      expect(sessionSource).toBeDefined();
      expect(sessionSource.uri).toContain("browser-session://session-test-commit");

      const sessionChunk = testDb
        .query<any, any>("SELECT * FROM chunks WHERE source_id = ?")
        .get(sessionSource.id);
      expect(sessionChunk).toBeDefined();
      expect(sessionChunk.chunk_type).toBe("synthetic");

      // Verify WebSession entity in graph
      const sessionEntity = testDb
        .query<any, any>("SELECT * FROM entities WHERE type = 'WebSession'")
        .get();
      expect(sessionEntity).toBeDefined();

      // Verify CONTAINS_PAGE edges
      const containsEdges = testDb
        .query<any, any>(
          "SELECT * FROM edges WHERE relation = 'CONTAINS_PAGE'",
        )
        .all();
      expect(containsEdges.length).toBe(2);
    });

    it("automatically closes session when idle threshold is exceeded", async () => {
      setActiveSession(testSdk, null);

      // First visit at t=0
      await recordSessionVisit(
        testSdk,
        {
          url: "https://page1.com",
          title: "Page 1",
          domain: "page1.com",
          visitedAt: 1000,
        },
        "session-old",
        { sessionInactivityMinutes: 10 },
      );

      // Next visit after 15 minutes (> 10m threshold)
      const afterIdle = 1000 + 15 * 60 * 1000;
      const res = await recordSessionVisit(
        testSdk,
        {
          url: "https://page2.com",
          title: "Page 2",
          domain: "page2.com",
          visitedAt: afterIdle,
        },
        undefined,
        { sessionInactivityMinutes: 10 },
      );

      // Old session should be finalized
      expect(res.finalizedSession).toBeDefined();
      expect(res.finalizedSession!.sessionId).toBe("session-old");

      // New active session should contain only page 2
      expect(res.activeSession.sessionId).not.toBe("session-old");
      expect(res.activeSession.visits.length).toBe(1);
    });
  });

  describe("7. Browser History & Bookmarks Batch Ingestion", () => {
    it("ingests history items with domain relationships while excluding social media", async () => {
      const payload = {
        type: "history_batch" as const,
        items: [
          {
            url: "https://developer.mozilla.org/en-US/docs/Web/API",
            title: "MDN Web API",
            visitTime: 1700000000000,
            visitCount: 5,
          },
          {
            url: "https://reddit.com/r/webdev",
            title: "Reddit WebDev",
            visitTime: 1700000000000,
            visitCount: 12,
          },
        ],
      };

      const res = await processHistoryBatch(testSdk, payload, {
        excludeDomains: ["reddit.com"],
      });
      expect(res.ingestedCount).toBe(1);
      expect(res.skippedCount).toBe(1);

      const mdnSource = testDb
        .query<any, any>("SELECT * FROM sources WHERE uri LIKE '%developer.mozilla.org%'")
        .get();
      expect(mdnSource).toBeDefined();
      expect(mdnSource.type).toBe("browser_history");

      const redditSource = testDb
        .query<any, any>("SELECT * FROM sources WHERE uri LIKE '%reddit.com%'")
        .get();
      expect(redditSource).toBeNull();
    });

    it("ingests bookmarks with folder hierarchy and BOOKMARKED_IN edges", async () => {
      const payload = {
        type: "bookmarks_batch" as const,
        items: [
          {
            id: "b1",
            title: "Bun Docs",
            url: "https://bun.sh/docs",
            folderPath: "Bookmarks Bar / Dev Resources",
            dateAdded: 1700000000000,
          },
        ],
      };

      const res = await processBookmarksBatch(testSdk, payload, {});
      expect(res.ingestedCount).toBe(1);

      const folderEntity = testDb
        .query<any, any>("SELECT * FROM entities WHERE type = 'BookmarkFolder'")
        .get();
      expect(folderEntity).toBeDefined();
      expect(folderEntity.name).toBe("Bookmarks Bar / Dev Resources");

      const bookmarkedInEdge = testDb
        .query<any, any>("SELECT * FROM edges WHERE relation = 'BOOKMARKED_IN'")
        .get();
      expect(bookmarkedInEdge).toBeDefined();
    });

    it("preserves rich pages, history, and bookmarks as separate sources", async () => {
      const url = "https://example.com/shared";
      await processPageVisit(testSdk, {
        type: "page_visit",
        url,
        title: "Shared Resource",
        textContent: "Rich live page content that must not be overwritten by metadata-only imports.",
        recordInSession: false,
      }, {});
      await processHistoryBatch(testSdk, {
        type: "history_batch",
        items: [{ url, title: "Shared Resource", visitTime: 1000 }],
      }, {});
      await processBookmarksBatch(testSdk, {
        type: "bookmarks_batch",
        items: [{ id: "bookmark-1", url, title: "Shared Resource", folderPath: "Research" }],
      }, {});

      const sources = testDb.query<any, any>(
        "SELECT type, uri FROM sources WHERE origin = 'browser' ORDER BY type",
      ).all();
      expect(sources).toHaveLength(3);
      expect(sources.map((source) => source.type).sort()).toEqual([
        "bookmark",
        "browser_history",
        "web_page",
      ]);
      expect(sources.find((source) => source.type === "web_page")?.uri).toBe(url);
    });

    it("efficiently batch ingests large history streams with batch embeddings", async () => {
      const items = Array.from({ length: 50 }, (_, i) => ({
        url: `https://docs.rs/crate-${i}/latest`,
        title: `Rust Crate ${i}`,
        visitTime: 1700000000000 - i * 100000,
        visitCount: i + 1,
      }));

      const res = await processHistoryBatch(
        testSdk,
        { type: "history_batch", items },
        {},
      );

      expect(res.ingestedCount).toBe(50);
      expect(res.skippedCount).toBe(0);

      const sourcesCount = testDb
        .query<any, any>("SELECT count(*) as count FROM sources WHERE type = 'browser_history'")
        .get();
      expect(sourcesCount.count).toBe(50);
    });
  });

  describe("8. Checkpoints & Crash Recovery", () => {
    it("recovers uncommitted checkpoints via recover.ts without re-calling LLM", async () => {
      // Save simulated page checkpoint
      testSdk.checkpoint.save(
        {
          type: "browser_page_analysis",
          pageData: {
            url: "https://sqlite.org/wasi.html",
            cleanUrl: "https://sqlite.org/wasi.html",
            domain: "sqlite.org",
            title: "SQLite WASI",
            textContent: "SQLite compiled to WebAssembly for browser environments.",
            visitedAt: 1700000000000,
          },
          analysis: {
            summary: "SQLite running in WebAssembly.",
            topics: ["SQLite", "WASI", "WebAssembly"],
            category: "Documentation",
          },
          namespace: "browser",
        },
        { id: "browser_page:https://sqlite.org/wasi.html" },
      );

      // Save simulated session checkpoint
      testSdk.checkpoint.save(
        {
          type: "browser_session_analysis",
          sessionId: "rec-session-123",
          startTime: 1000,
          endTime: 2000,
          visits: [
            {
              url: "https://sqlite.org/wasi.html",
              title: "SQLite WASI",
              domain: "sqlite.org",
              visitedAt: 1500,
            },
          ],
          synthesis: {
            sessionTitle: "Exploring WebAssembly SQLite",
            summary: "Investigated SQLite compilation to WebAssembly.",
            topics: ["SQLite", "WebAssembly"],
            dominantDomains: ["sqlite.org"],
          },
          namespace: "browser",
        },
        { id: "browser_session:rec-session-123" },
      );

      expect(testSdk.checkpoint.getQueue().length).toBe(2);

      // Run recovery
      const recResult = await runRecover(testSdk);
      expect(recResult.recoveredPages).toBe(1);
      expect(recResult.recoveredSessions).toBe(1);

      // Checkpoints resolved
      expect(testSdk.checkpoint.getQueue().length).toBe(0);

      // Check that sources exist in DB
      const pageSource = testDb
        .query<any, any>("SELECT * FROM sources WHERE uri = ?")
        .get("https://sqlite.org/wasi.html");
      expect(pageSource).toBeDefined();

      const sessionSource = testDb
        .query<any, any>("SELECT * FROM sources WHERE type = 'web_session'")
        .get();
      expect(sessionSource).toBeDefined();
    });
  });

  describe("9. Cron & Push Ingestion Hook", () => {
    it("coalesces duplicate page events and caps queued DOM material", async () => {
      const makeMaterial = (title: string) => ({
        target_processor: "browser",
        content: JSON.stringify({
          type: "page_visit",
          url: "https://example.com/duplicate?utm_source=first",
          title,
          textContent: "x".repeat(25_000),
          html: "h".repeat(30_000),
          recordInSession: false,
        }),
        metadata: { connector: "chrome-extension", data_origin: "chrome" },
      });
      await subscribe(makeMaterial("Older"), testSdk);
      await subscribe(makeMaterial("Newest"), testSdk);

      const queue = testSdk.state.getJson<any[]>("pending-ingest")!;
      expect(queue).toHaveLength(1);
      expect(queue[0].payload.title).toBe("Newest");
      expect(queue[0].payload.textContent).toHaveLength(20_000);
      expect(queue[0].payload.html).toHaveLength(20_000);
    });

    it("queues inbound IngestMaterial and lets the cron parse it", async () => {
      const material = {
        target_processor: "browser",
        content: JSON.stringify({
          type: "page_visit",
          url: "https://example.com/test-subscribe",
          title: "Subscribe Test Page",
          textContent: "Testing push ingestion pipeline through subscribe hook.",
        }),
        metadata: {
          connector: "chrome-extension",
          data_origin: "chrome",
        },
      };

      await subscribe(material, testSdk);

      // The HTTP hook is deliberately cheap: no source exists until the cron drains it.
      expect(testDb.query<any, any>("SELECT * FROM sources WHERE uri = ?").get("https://example.com/test-subscribe")).toBeNull();
      const cronResult = await runCron(testSdk);
      expect(cronResult.processedPayloads).toBe(1);
      const source = testDb
        .query<any, any>("SELECT * FROM sources WHERE uri = ?")
        .get("https://example.com/test-subscribe");
      expect(source).toBeDefined();
      expect(source.title).toBe("Subscribe Test Page");
    });

    it("runs cron without errors when no idle sessions are pending", async () => {
      const res = await runCron(testSdk);
      expect(res.finalizedSessionTitle).toBeNull();
    });
  });

  describe("10. Strict Two-Phase Local GPU Optimization Pattern", () => {
    it("enforces strict two-phase execution: all chat model requests complete before any embedding request starts", async () => {
      const callLog: Array<"chat" | "embedding"> = [];

      const mockFetch: typeof fetch = async (url: any) => {
        const urlStr = url.toString();
        if (urlStr.includes("/chat/completions")) {
          callLog.push("chat");
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: JSON.stringify({
                      summary: "Page summary generated by chat model.",
                      topics: ["TopicA", "TopicB"],
                      category: "Documentation",
                    }),
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        } else if (urlStr.includes("/embeddings")) {
          callLog.push("embedding");
          return new Response(
            JSON.stringify({
              object: "list",
              data: [
                { index: 0, embedding: new Array(4096).fill(0.01) },
                { index: 1, embedding: new Array(4096).fill(0.02) },
                { index: 2, embedding: new Array(4096).fill(0.03) },
                { index: 3, embedding: new Array(4096).fill(0.04) },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      };

      const twoPhaseSdk = createExtensionSDK(
        "browser two-phase",
        "browser",
        testDb,
        { fetchFn: mockFetch },
        undefined,
        undefined,
        undefined,
        testBus,
      );

      // Simulated batch of 3 open tabs (with text > minContentLength of 100 chars)
      const tabsPayload: TabsBatchPayload = {
        type: "tabs_batch",
        pages: [
          {
            type: "page_visit",
            url: "https://example.com/page1",
            title: "Page One",
            textContent:
              "Comprehensive long content for page one to trigger full LLM analysis properly. It includes deep architectural details about graph databases, vector indexes, and semantic search paradigms.",
          },
          {
            type: "page_visit",
            url: "https://example.com/page2",
            title: "Page Two",
            textContent:
              "Comprehensive long content for page two to trigger full LLM analysis properly. Discussing Bun runtime internals, SQLite integration, and performance benchmarking across various platforms.",
          },
          {
            type: "page_visit",
            url: "https://example.com/page3",
            title: "Page Three",
            textContent:
              "Comprehensive long content for page three to trigger full LLM analysis properly. Covering neural embedding models, chunking strategies, and knowledge graph edge traversal optimizations.",
          },
        ],
      };

      const result = await processTabsBatch(twoPhaseSdk, tabsPayload, {
        enableLlmAnalysis: true,
      });

      expect(result.ingestedCount).toBe(3);

      // Verify that chat model requests and embedding requests occurred
      const chatCalls = callLog.filter((c) => c === "chat");
      const embedCalls = callLog.filter((c) => c === "embedding");
      expect(chatCalls.length).toBe(3);
      expect(embedCalls.length).toBeGreaterThanOrEqual(3);

      // Crucial assertion: All chat calls must happen strictly before the first embedding call
      const firstEmbedIndex = callLog.indexOf("embedding");
      const lastChatIndex = callLog.lastIndexOf("chat");

      expect(firstEmbedIndex).toBeGreaterThan(-1);
      expect(lastChatIndex).toBeGreaterThan(-1);
      expect(lastChatIndex).toBeLessThan(firstEmbedIndex);

      // Verify zero interleaving: no chat calls after the first embedding call
      const callsAfterFirstEmbed = callLog.slice(firstEmbedIndex);
      expect(callsAfterFirstEmbed.every((c) => c === "embedding")).toBe(true);
    });

    it("handles tabs_batch via push ingestion hook subscribe()", async () => {
      const material = {
        target_processor: "browser",
        content: JSON.stringify({
          type: "tabs_batch",
          pages: [
            {
              type: "page_visit",
              url: "https://example.com/batch-tab-1",
              title: "Batch Tab 1",
              textContent: "Content for batch tab 1 testing subscribe hook.",
            },
            {
              type: "page_visit",
              url: "https://example.com/batch-tab-2",
              title: "Batch Tab 2",
              textContent: "Content for batch tab 2 testing subscribe hook.",
            },
          ],
        }),
        metadata: {
          connector: "chrome-extension",
          data_origin: "chrome",
        },
      };

      await subscribe(material, testSdk);

      const cronResult = await runCron(testSdk);
      expect(cronResult.processedPayloads).toBe(1);

      const src1 = testDb
        .query<any, any>("SELECT * FROM sources WHERE uri = ?")
        .get("https://example.com/batch-tab-1");
      const src2 = testDb
        .query<any, any>("SELECT * FROM sources WHERE uri = ?")
        .get("https://example.com/batch-tab-2");

      expect(src1).toBeDefined();
      expect(src2).toBeDefined();
    });
  });
});
