import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createExtensionSDK,
  StateManager,
  ContextHydrator,
  GraphIngestor,
  UnifiedIngestor,
  getSDK,
  runWithSDK,
  findNearestManifest,
  state,
  context,
  graph,
  ingest,
  getWatermark,
  setWatermark,
  getState,
  setState,
  deleteState,
  getStateJson,
  setStateJson,
  getAllState,
  hydrateContext,
  getRecentChunks,
  ingestGraph,
  ingestSourceAndChunks,
  CheckpointManager,
  checkpoint,
  saveCheckpoint,
  getCheckpoints,
  getQueuedCheckpoints,
  getCheckpointContext,
  hasCheckpoints,
  clearCheckpoints,
  deleteCheckpoint,
  Logger,
  logger,
  log,
  info,
  warn,
  error,
  debug,
} from "../sdk";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");

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

  // FTS5 virtual table
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text_content, 
      content='chunks', 
      content_rowid='id', 
      tokenize='porter'
    );
  `);

  // Triggers
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

  db.run(`
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text_content) VALUES ('delete', old.id, old.text_content);
      INSERT INTO chunks_fts(rowid, text_content) VALUES (new.id, new.text_content);
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

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_checkpoints_extension_status
    ON checkpoints(extension_id, status, created_at);
  `);

  // Entities with namespacing
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

  // Chunk entities
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

describe("Shale SDK Architecture", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  describe("1. State Management Module", () => {
    it("manages watermarks and cursors scoped to extensionId", () => {
      const sdkA = createExtensionSDK("discord-bot", "discord", db);
      const sdkB = createExtensionSDK("slack-bot", "slack", db);

      // Default watermark key
      sdkA.state.setWatermark("msg-100");
      sdkB.state.setWatermark("msg-200");

      expect(sdkA.state.getWatermark()).toBe("msg-100");
      expect(sdkB.state.getWatermark()).toBe("msg-200");

      // Custom key watermark
      sdkA.state.setWatermark("thread-10", "channel-general");
      expect(sdkA.state.getWatermark("channel-general")).toBe("thread-10");
      expect(sdkB.state.getWatermark("channel-general")).toBeNull();

      // JSON helpers
      sdkA.state.setJson("config", { autoSync: true, batchSize: 50 });
      const config = sdkA.state.getJson<{
        autoSync: boolean;
        batchSize: number;
      }>("config");
      expect(config).toEqual({ autoSync: true, batchSize: 50 });

      // Delete key
      expect(sdkA.state.delete("config")).toBe(true);
      expect(sdkA.state.get("config")).toBeNull();

      // List all
      const allA = sdkA.state.getAll();
      expect(allA.length).toBe(2);
      expect(allA.map((r) => r.state_key)).toEqual([
        "channel-general",
        "watermark",
      ]);
    });
  });

  describe("2. Context Hydration Module", () => {
    it("retrieves recent chunks ordered chronologically", () => {
      const hydrator = new ContextHydrator(db);

      // Insert test source and 15 chunks
      db.run(`
        INSERT INTO sources (id, type, uri, origin, created_at, title, updated_at, hash)
        VALUES ('thread-1', 'chat', 'chat://general', 'discord', 1000, 'Discord General', 1000, 'h1');
      `);

      for (let i = 0; i < 15; i++) {
        db.run(
          `INSERT INTO chunks (id, source_id, chunk_index, text_content) VALUES (?, 'thread-1', ?, ?);`,
          [i + 1, i, `Message ${i}`],
        );
      }

      // Request latest 5 chunks
      const context = hydrator.hydrate("chat://general", 5);

      expect(context.chunks.length).toBe(5);
      // Chunks should be 10, 11, 12, 13, 14 in chronological order
      expect(context.chunks.map((c) => c.chunk_index)).toEqual([
        10, 11, 12, 13, 14,
      ]);
      expect(context.chunks[0].text_content).toBe("Message 10");
      expect(context.chunks[0].chunk_type).toBe("verbatim");
      expect(context.chunks[4].text_content).toBe("Message 14");
      expect(context.chunks[4].chunk_type).toBe("verbatim");
      expect(context.title).toBe("Discord General");
      expect(context.combinedText).toContain("Message 10\n\nMessage 11");
    });

    it("retrieves and filters sources via getSources, getAllSources, and getSource", () => {
      const hydrator = new ContextHydrator(db);

      db.run(`
        INSERT INTO sources (id, type, uri, origin, created_at, title, updated_at, hash)
        VALUES 
          ('src-1', 'markdown_note', 'file:///note1.md', 'obsidian', 100, 'Note 1', 100, 'h1'),
          ('src-2', 'markdown_note', 'file:///note2.md', 'obsidian', 200, 'Note 2', 200, 'h2'),
          ('src-3', 'image', 'file:///img.png', 'obsidian', 300, 'Image 1', 300, 'h3');
      `);

      // All sources
      const all = hydrator.getAllSources();
      expect(all.length).toBeGreaterThanOrEqual(3);

      // Filter by since watermark
      const updated = hydrator.getSources({ since: 150 });
      expect(updated.map((s) => s.id)).toEqual(["src-2", "src-3"]);

      // Filter by type
      const notes = hydrator.getSources({ type: "markdown_note", since: 50 });
      expect(notes.map((s) => s.id)).toEqual(["src-1", "src-2"]);

      // Get single source by ID and URI
      const s1 = hydrator.getSource("src-1");
      expect(s1?.title).toBe("Note 1");

      const s2 = hydrator.getSource("file:///note2.md");
      expect(s2?.id).toBe("src-2");

      expect(hydrator.getSource("nonexistent")).toBeNull();
    });
  });

  describe("3. Graph Ingestion Module", () => {
    it("resolves entity names to IDs and persists relationships", () => {
      const graph = new GraphIngestor("test-ns", db);

      const res = graph.ingest({
        entities: [
          { name: "TypeScript", type: "Language" },
          { name: "Bun", type: "Runtime" },
          { name: "SQLite", type: "Database" },
        ],
        edges: [
          {
            source: "Bun",
            target: "TypeScript",
            relation: "SUPPORTS",
            weight: 1.0,
            metadata: { reason: "Native TypeScript execution engine" },
          },
          { source: "Bun", target: "SQLite", relation: "EMBEDS", weight: 0.9 },
        ],
      });

      expect(res.entitiesInserted).toBe(3);
      expect(res.edgesInserted).toBe(2);
      expect(res.entityMap["TypeScript"]).toBeDefined();
      expect(res.entityMap["Bun"]).toBeDefined();
      expect(res.entityMap["SQLite"]).toBeDefined();

      // Verify edges in database
      const edges = db
        .query<{
          source_entity_id: number;
          target_entity_id: number;
          relation: string;
          weight: number;
          metadata: string | null;
        }, []>(
          "SELECT source_entity_id, target_entity_id, relation, weight, metadata FROM edges ORDER BY relation ASC",
        )
        .all();

      expect(edges.length).toBe(2);
      expect(edges[0].relation).toBe("EMBEDS");
      expect(edges[0].source_entity_id).toBe(res.entityMap["Bun"]);
      expect(edges[0].target_entity_id).toBe(res.entityMap["SQLite"]);
      expect(edges[0].metadata).toBeNull();

      expect(edges[1].relation).toBe("SUPPORTS");
      expect(edges[1].source_entity_id).toBe(res.entityMap["Bun"]);
      expect(edges[1].target_entity_id).toBe(res.entityMap["TypeScript"]);
      expect(edges[1].metadata).toBeDefined();
      const meta = JSON.parse(edges[1].metadata!);
      expect(meta.reason).toBe("Native TypeScript execution engine");
    });

    it("throws clear error when an edge references an unknown entity", () => {
      const graph = new GraphIngestor("test-ns", db);

      expect(() => {
        graph.ingest({
          entities: [{ name: "Alice", type: "Person" }],
          edges: [{ source: "Alice", target: "Bob", relation: "KNOWS" }],
        });
      }).toThrow(/unknown entity "Bob"/);
    });
  });

  describe("4. Unified Source & Chunk Ingestion Module", () => {
    it("atomically inserts source, text chunks, and entity links in one transaction", () => {
      const ingestor = new UnifiedIngestor("docs", db);

      const res = ingestor.sourceAndChunks({
        source: {
          id: "doc-1",
          type: "note",
          uri: "file:///notes/architecture.md",
          origin: "obsidian",
          title: "Architecture Guide",
        },
        chunks: [
          {
            text_content: "Section 1: High level architecture overview",
            entity_names: ["Architecture"],
          },
          {
            text_content: "Section 2: Database schemas and triggers",
            entity_names: ["Database", "Trigger"],
          },
        ],
      });

      expect(res.sourceId).toBe("doc-1");
      expect(res.chunkIds.length).toBe(3);

      // Verify sources row
      const source = db
        .query<{
          title: string;
        }, []>("SELECT title FROM sources WHERE id = 'doc-1'")
        .get();
      expect(source?.title).toBe("Architecture Guide");

      // Verify chunks
      const chunks = db
        .query<{
          text_content: string;
        }, []>(
          "SELECT text_content FROM chunks WHERE source_id = 'doc-1' ORDER BY chunk_index ASC",
        )
        .all();
      expect(chunks.length).toBe(3);
      expect(chunks[0].text_content).toContain("High level architecture overview");
      expect(chunks.slice(1).map(chunk => chunk.text_content).join(" ")).toContain("Section 1: High level architecture overview");

      // Verify FTS5
      const ftsResults = db
        .query("SELECT * FROM chunks_fts WHERE chunks_fts MATCH 'architecture'")
        .all();
      expect(ftsResults.length).toBe(2);

      // Verify entity links
      const links = db
        .query<{
          chunk_id: number;
          entity_id: number;
        }, []>("SELECT chunk_id, entity_id FROM chunk_entities")
        .all();
      expect(links.length).toBe(3); // 1 for "Architecture", 2 for "Database" & "Trigger"
    });

    it("rolls back all changes if chunk insertion fails", () => {
      const ingestor = new UnifiedIngestor("docs", db);
      db.run("CREATE TRIGGER fail_chunk BEFORE INSERT ON chunks BEGIN SELECT RAISE(FAIL, 'injected chunk failure'); END");

      expect(() => {
        ingestor.sourceAndChunks({
          source: {
            id: "doc-bad",
            type: "note",
            uri: "file:///bad.md",
            origin: "test",
            title: "Bad Doc",
          },
          chunks: [{ text_content: "Valid chunk" }],
        });
      }).toThrow();

      // Verify nothing was committed to sources or chunks
      const sourceCount = db
        .query<{
          c: number;
        }, []>("SELECT count(*) as c FROM sources WHERE id = 'doc-bad'")
        .get()!.c;
      const chunkCount = db
        .query<{
          c: number;
        }, []>("SELECT count(*) as c FROM chunks WHERE source_id = 'doc-bad'")
        .get()!.c;

      expect(sourceCount).toBe(0);
      expect(chunkCount).toBe(0);
    });
  });

  describe("Phase 4: Stateless Extension Workflow End-to-End", () => {
    it("executes the full 6-step stateless lifecycle correctly", () => {
      const sdk = createExtensionSDK("discord-feed", "discord", db);

      // Step 1: Check Watermark
      const initialWatermark = sdk.state.getWatermark("channel-news") ?? "0";
      expect(initialWatermark).toBe("0");

      // Step 2: Fetch Delta (simulate external API returning 2 new messages)
      const mockExternalMessages = [
        { id: "101", text: "New release v1.0 announced!" },
        { id: "102", text: "Check out the new features." },
      ];

      // Step 3: Hydrate Context (retrieve historical context)
      const channelUri = "discord://channel/news";
      const historicalContext = sdk.context.hydrate(channelUri, 10);
      expect(historicalContext.chunks.length).toBe(0);

      // Step 4: Process Contextually (LLM combines history + new data)
      const combinedInput = `${historicalContext.combinedText}\n${mockExternalMessages.map((m) => m.text).join("\n")}`;
      expect(combinedInput).toContain("New release v1.0");

      // Step 5: Ingest (atomic commit)
      const ingestRes = sdk.ingest.sourceAndChunks({
        source: {
          id: "news-source-1",
          type: "channel_feed",
          uri: channelUri,
          origin: "discord",
          title: "Discord News Feed",
        },
        chunks: mockExternalMessages.map((msg, idx) => ({
          chunk_index: idx,
          text_content: msg.text,
        })),
      });
      expect(ingestRes.chunksCount).toBe(3);

      sdk.graph.ingest({
        entities: [
          { name: "v1.0", type: "Release" },
          { name: "Discord", type: "Platform" },
        ],
        edges: [{ source: "Discord", target: "v1.0", relation: "ANNOUNCED" }],
      });

      // Step 6: Advance Watermark
      const latestMessageId =
        mockExternalMessages[mockExternalMessages.length - 1].id;
      sdk.state.setWatermark(latestMessageId, "channel-news");

      // Verification: On the NEXT tick/run, the extension sees the updated watermark!
      const nextTickWatermark = sdk.state.getWatermark("channel-news");
      expect(nextTickWatermark).toBe("102");

      // And context hydration on the next run now retrieves the 2 chunks!
      const nextContext = sdk.context.hydrate(channelUri, 10);
      expect(nextContext.chunks.length).toBe(3);
      expect(nextContext.combinedText).toContain("New release v1.0");
      expect(nextContext.combinedText).toContain("Check out the new features.");
    });
  });

  describe("5. Automatic Manifest Discovery", () => {
    it("finds manifest.json in the current directory and extracts identity", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "shale-manifest-test-"));
      writeFileSync(
        join(tempDir, "manifest.json"),
        JSON.stringify({
          name: "test-plugin",
          version: "1.2.3",
          description: "A test plugin",
          namespace: "test-ns",
        }),
      );

      const res = findNearestManifest(tempDir);
      expect(res).not.toBeNull();
      expect(res!.manifest.name).toBe("test-plugin");
      expect(res!.manifest.version).toBe("1.2.3");
      expect(res!.manifest.namespace).toBe("test-ns");
      expect(res!.dir).toBe(tempDir);

      const sdk = getSDK(tempDir);
      expect(sdk.extensionId).toBe("test-plugin");
      expect(sdk.namespace).toBe("test-ns");
    });

    it("traverses upwards from a nested subfolder to find parent manifest.json", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "shale-nested-test-"));
      const nestedDir = join(tempDir, "src", "submodule", "deep");
      mkdirSync(nestedDir, { recursive: true });

      writeFileSync(
        join(tempDir, "manifest.json"),
        JSON.stringify({
          name: "parent-plugin",
          version: "2.0.0",
          description: "Parent extension",
        }),
      );

      const res = findNearestManifest(nestedDir);
      expect(res).not.toBeNull();
      expect(res!.manifest.name).toBe("parent-plugin");
      expect(res!.dir).toBe(tempDir);

      const sdk = getSDK(nestedDir);
      expect(sdk.extensionId).toBe("parent-plugin");
      // When namespace is omitted, defaults to extensionId (parent-plugin)
      expect(sdk.namespace).toBe("parent-plugin");
    });

    it("falls back gracefully when outside any extension directory", () => {
      const tempEmptyDir = mkdtempSync(join(tmpdir(), "empty-dir-"));
      const res = findNearestManifest(tempEmptyDir);
      expect(res).toBeNull();
    });
  });

  describe("6. AsyncLocalStorage Ambient Scope Propagation", () => {
    it("propagates active SDK across synchronous and asynchronous execution", async () => {
      const customSdk = createExtensionSDK("ambient-test", "ambient-ns", db);

      // Outside runWithSDK: getSDK does not return customSdk
      expect(getSDK().extensionId).not.toBe("ambient-test");

      await runWithSDK(customSdk, async () => {
        // Direct call
        expect(getSDK().extensionId).toBe("ambient-test");
        expect(getSDK().namespace).toBe("ambient-ns");

        // Across nested async boundary
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(getSDK().extensionId).toBe("ambient-test");

        // Helper function in another scope
        function subHelper() {
          return getSDK().extensionId;
        }
        expect(subHelper()).toBe("ambient-test");
      });

      // Outside again
      expect(getSDK().extensionId).not.toBe("ambient-test");
    });
  });

  describe("7. Top-Level Convenience Functions & Proxies", () => {
    it("allows direct state operations without passing sdk", () => {
      const scopedSdk = createExtensionSDK("convenience-test", "conv-ns", db);

      runWithSDK(scopedSdk, () => {
        // Direct convenience functions
        setWatermark("sync-999");
        expect(getWatermark()).toBe("sync-999");

        setState("user_pref", "dark_mode");
        expect(getState("user_pref")).toBe("dark_mode");

        setStateJson("batch_meta", { count: 42, processed: true });
        const meta = getStateJson<{ count: number; processed: boolean }>(
          "batch_meta",
        );
        expect(meta).toEqual({ count: 42, processed: true });

        expect(deleteState("user_pref")).toBe(true);
        expect(getState("user_pref")).toBeNull();

        const all = getAllState();
        expect(all.length).toBe(2);

        // Module proxy (state.getWatermark, state.setWatermark)
        state.setWatermark("sync-1000");
        expect(state.getWatermark()).toBe("sync-1000");
      });
    });

    it("allows context hydration, graph ingestion, and source ingestion via convenience functions and proxies", () => {
      const scopedSdk = createExtensionSDK("ingest-test", "ingest-ns", db);

      runWithSDK(scopedSdk, () => {
        // Ingest source & chunks via top-level function
        const res = ingestSourceAndChunks({
          source: {
            id: "src-convenience-1",
            type: "doc",
            uri: "file:///test/doc.md",
            origin: "convenience",
            title: "Convenience Functions Test",
          },
          chunks: [
            {
              text_content: "Chunk one discussing convenience APIs.",
            },
            {
              text_content: "Chunk two discussing ambient async local storage.",
            },
          ],
        });

        expect(res.sourceId).toBe("src-convenience-1");
        expect(res.chunksCount).toBe(3);

        // Context hydration via top-level function
        const hydrated = hydrateContext("file:///test/doc.md", 5);
        expect(hydrated.chunks.length).toBe(3);
        expect(hydrated.combinedText).toContain("Chunk one");
        expect(hydrated.combinedText).toContain("Chunk two");

        const recent = getRecentChunks("file:///test/doc.md", 1);
        expect(recent.length).toBe(1);
        expect(recent[0].text_content).toBe(
          "Chunk two discussing ambient async local storage.",
        );

        // Graph ingestion via proxy
        const graphRes = graph.ingest({
          entities: [
            { name: "Convenience API", type: "Feature" },
            { name: "Shale SDK", type: "Package" },
          ],
          edges: [
            {
              source: "Shale SDK",
              target: "Convenience API",
              relation: "PROVIDES",
            },
          ],
        });

        expect(graphRes.entitiesInserted).toBe(2);
        expect(graphRes.edgesInserted).toBe(1);

        // Graph ingestion via direct function
        const graphRes2 = ingestGraph({
          entities: [{ name: "AsyncLocalStorage", type: "Runtime" }],
          edges: [
            {
              source: "Shale SDK",
              target: "AsyncLocalStorage",
              relation: "USES",
            },
          ],
        });
        expect(graphRes2.entitiesInserted).toBe(1);
        expect(graphRes2.edgesInserted).toBe(1);
      });
    });
  });

  describe("8. Universal Logger Module", () => {
    it("automatically prepends the extension name before content", () => {
      const logs: Array<{ level: string; args: any[] }> = [];
      const customLogger = new Logger({
        name: "test-extension",
        output: (level, ...args) => {
          logs.push({ level, args });
        },
      });

      customLogger.log("Hello world");
      customLogger.info("Informational message", { detail: 123 });
      customLogger.warn("Warning emitted");
      customLogger.error("Error occurred");
      customLogger.debug("Debugging data");

      expect(logs.length).toBe(5);
      expect(logs[0].level).toBe("log");
      expect(logs[0].args[0]).toBe("[test-extension] Hello world");

      expect(logs[1].level).toBe("info");
      expect(logs[1].args[0]).toBe("[test-extension] Informational message");
      expect(logs[1].args[1]).toEqual({ detail: 123 });

      expect(logs[2].level).toBe("warn");
      expect(logs[2].args[0]).toBe("[test-extension] Warning emitted");

      expect(logs[3].level).toBe("error");
      expect(logs[3].args[0]).toBe("[test-extension] Error occurred");

      expect(logs[4].level).toBe("debug");
      expect(logs[4].args[0]).toBe("[test-extension] Debugging data");
    });

    it("does not duplicate prefix if text already starts with prefix", () => {
      const logs: string[] = [];
      const customLogger = new Logger({
        name: "my-ext",
        output: (_level, ...args) => logs.push(args[0]),
      });

      customLogger.log("[my-ext] already formatted");
      expect(logs[0]).toBe("[my-ext] already formatted");
    });

    it("prepends prefix as first argument when first arg is an object or error", () => {
      const logs: any[] = [];
      const customLogger = new Logger({
        name: "obj-ext",
        output: (_level, ...args) => logs.push(args),
      });

      const err = new Error("test failure");
      customLogger.error(err);
      expect(logs[0][0]).toBe("[obj-ext]");
      expect(logs[0][1]).toBe(err);
    });

    it("integrates with ShaleSDK instance via sdk.logger", () => {
      const sdk = createExtensionSDK("custom-plugin", "custom-ns", db);
      expect(sdk.logger).toBeDefined();
      expect(sdk.logger.name).toBe("custom-plugin");
      expect(sdk.logger.prefix).toBe("[custom-plugin]");
    });

    it("resolves ambient SDK logger via top-level logger proxy and convenience functions", async () => {
      const customSdk = createExtensionSDK("ambient-plugin", "amb-ns", db);

      await runWithSDK(customSdk, async () => {
        expect(logger.name).toBe("ambient-plugin");
        expect(logger.prefix).toBe("[ambient-plugin]");

        // Direct function invocation
        const captured: string[] = [];
        const originalLog = console.log;
        console.log = (...args: any[]) => {
          captured.push(args.join(" "));
        };

        try {
          logger("Testing callable logger proxy");
          logger.log("Testing method call");
          log("Testing convenience log function");
        } finally {
          console.log = originalLog;
        }

        expect(captured.length).toBe(3);
        expect(captured[0]).toBe("[ambient-plugin] Testing callable logger proxy");
        expect(captured[1]).toBe("[ambient-plugin] Testing method call");
        expect(captured[2]).toBe("[ambient-plugin] Testing convenience log function");
      });
    });

    it("supports hierarchical child loggers", () => {
      const parentLogger = new Logger("vault-engine");
      const childLogger = parentLogger.child("subsystem");
      expect(childLogger.name).toBe("vault-engine:subsystem");
      expect(childLogger.prefix).toBe("[vault-engine:subsystem]");
    });
  });

  describe("CheckpointManager & ShaleSDK Checkpoint Integration", () => {
    it("saves and retrieves queued checkpoints in FIFO order", () => {
      const mgr = new CheckpointManager("ext-test-1", db);

      expect(mgr.hasQueued()).toBe(false);
      expect(mgr.hasCheckpoints()).toBe(false);

      const cp1 = mgr.save({ step: 1, file: "a.md" }, "step-1");
      const cp2 = mgr.save({ step: 2, file: "b.md" }, "step-2");

      expect(cp1.id).toBeDefined();
      expect(cp1.key).toBe("step-1");
      expect(cp1.data).toEqual({ step: 1, file: "a.md" });

      expect(mgr.hasQueued()).toBe(true);
      expect(mgr.hasCheckpoints()).toBe(true);

      const queue = mgr.getQueue();
      expect(queue.length).toBe(2);
      expect(queue[0].key).toBe("step-1");
      expect(queue[0].data).toEqual({ step: 1, file: "a.md" });
      expect(queue[1].key).toBe("step-2");
      expect(queue[1].data).toEqual({ step: 2, file: "b.md" });
    });

    it("isolates checkpoints across different extension IDs", () => {
      const mgrA = new CheckpointManager("ext-A", db);
      const mgrB = new CheckpointManager("ext-B", db);

      mgrA.save({ work: "A" });
      mgrB.save({ work: "B" });

      expect(mgrA.getQueue().length).toBe(1);
      expect(mgrA.getQueue()[0].data).toEqual({ work: "A" });

      expect(mgrB.getQueue().length).toBe(1);
      expect(mgrB.getQueue()[0].data).toEqual({ work: "B" });

      mgrA.clear();
      expect(mgrA.hasQueued()).toBe(false);
      expect(mgrB.hasQueued()).toBe(true);
    });

    it("provides complete CheckpointContext via getContext()", () => {
      const mgr = new CheckpointManager("ext-ctx-test", db);

      mgr.save({ item: 1 }, "first");
      mgr.save({ item: 2 }, "second");
      mgr.save({ item: 3 }, "third");

      const ctx = mgr.getContext();
      expect(ctx.extensionId).toBe("ext-ctx-test");
      expect(ctx.count).toBe(3);
      expect(ctx.earliest?.key).toBe("first");
      expect(ctx.latest?.key).toBe("third");
      expect(ctx.get("second")?.data).toEqual({ item: 2 });

      // Test resolve individual item
      const toResolve = ctx.checkpoints[1].id;
      expect(ctx.resolve(toResolve)).toBe(true);
      expect(mgr.getQueue().length).toBe(2);

      // Test clear all queued
      ctx.clear();
      expect(mgr.hasQueued()).toBe(false);
    });

    it("exposes checkpoint methods directly on ShaleSDK instance", () => {
      const sdk = createExtensionSDK("sdk-ext-cp", "test-ns", db);

      expect(sdk.hasCheckpoints()).toBe(false);

      sdk.saveCheckpoint({ processed: 100 }, "progress");
      expect(sdk.hasCheckpoints()).toBe(true);

      const queue = sdk.getCheckpoints();
      expect(queue.length).toBe(1);
      expect(queue[0].key).toBe("progress");
      expect(queue[0].data).toEqual({ processed: 100 });

      const ctx = sdk.getCheckpointContext();
      expect(ctx.count).toBe(1);
      expect(ctx.latest?.key).toBe("progress");

      sdk.clearCheckpoints();
      expect(sdk.hasCheckpoints()).toBe(false);
    });

    it("supports ambient checkpoint proxy and convenience functions within runWithSDK", async () => {
      const sdk = createExtensionSDK("ambient-cp-ext", "amb-cp-ns", db);

      await runWithSDK(sdk, async () => {
        expect(hasCheckpoints()).toBe(false);

        saveCheckpoint({ notes: ["note1.md", "note2.md"] }, "notes-batch");
        expect(hasCheckpoints()).toBe(true);

        const checkpoints = getCheckpoints();
        expect(checkpoints.length).toBe(1);
        expect(checkpoints[0].key).toBe("notes-batch");

        const queued = getQueuedCheckpoints();
        expect(queued.length).toBe(1);

        const ctx = getCheckpointContext();
        expect(ctx.count).toBe(1);
        expect(ctx.checkpoints[0].data).toEqual({ notes: ["note1.md", "note2.md"] });

        // Using proxy
        expect(checkpoint.hasQueued()).toBe(true);

        clearCheckpoints();
        expect(hasCheckpoints()).toBe(false);
      });
    });
  });
});
