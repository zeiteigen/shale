import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createExtensionSDK } from "../sdk";
import { isTExtensionManifest } from "../lib/extension";
import { createMessageBus, MessageBus } from "../lib/messages";
import {
  canProcessImage,
  describeImageWithChatModel,
  parseImageFile,
  processImageFile,
  processImageFilesBatch,
} from "../extensions/process-image/process-image";
import { setup as setupProcessImage } from "../extensions/process-image/setup";
import {
  ingestImageFile,
  parseImageFile as obsidianParseImageFile,
  parseImageFilesBatch as obsidianParseImageFilesBatch,
} from "../extensions/obsidian/index";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");

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


  db.run(`
    CREATE TABLE IF NOT EXISTS extension_state (
      extension_id TEXT NOT NULL,
      state_key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (extension_id, state_key)
    ) STRICT;
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY,
      namespace TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      UNIQUE (namespace, name)
    ) STRICT;
  `);

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

describe("Process Image Extension & Unified Cross-Extension Messaging", () => {
  describe("1. Manifest & Settings Schemas", () => {
    it("has a valid manifest.json complying with ExtensionManifest", () => {
      const manifestPath = join(
        import.meta.dir,
        "../extensions/process-image/manifest.json",
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      expect(isTExtensionManifest(manifest)).toBe(true);
      expect(manifest.name).toBe("process-image");
      expect(manifest.namespace).toBe("images");
      expect(manifest.setup_script).toBe("setup.ts");
    });

    it("has valid settings.json and settings.help.json schemas", () => {
      const settingsPath = join(
        import.meta.dir,
        "../extensions/process-image/settings.json",
      );
      const helpPath = join(
        import.meta.dir,
        "../extensions/process-image/settings.help.json",
      );

      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const help = JSON.parse(readFileSync(helpPath, "utf-8"));

      expect(help.extension).toBe("process-image");
      expect(help.settings.describeImages).toBeDefined();
      expect(help.settings.imagePrompt).toBeDefined();
      expect(help.settings.imageSystemPrompt).toBeDefined();
      expect(help.settings.imageTimeoutMs).toBeDefined();
      expect(help.settings.supportedExtensions).toBeDefined();

      for (const [key, val] of Object.entries(settings)) {
        expect(help.settings[key]).toBeDefined();
      }
    });
  });

  describe("2. Image File Recognition & Utilities", () => {
    it("recognizes standard image file formats", () => {
      expect(canProcessImage("photo.png")).toBe(true);
      expect(canProcessImage("diagram.JPG")).toBe(true);
      expect(canProcessImage("schema.webp")).toBe(true);
      expect(canProcessImage("drawing.svg")).toBe(true);
      expect(canProcessImage("animation.gif")).toBe(true);
      expect(canProcessImage("document.pdf")).toBe(false);
      expect(canProcessImage("notes.md")).toBe(false);
    });

    it("supports custom extension overrides", () => {
      expect(canProcessImage("render.heic", ["heic", "raw"])).toBe(true);
      expect(canProcessImage("render.png", ["heic"])).toBe(false);
    });
  });

  describe("3. Multimodal LLM Image Processing & Messaging", () => {
    it("processes image and returns chunks, entities, and edges over file:process channel", async () => {
      const bus = createMessageBus();
      const db = createTestDb();

      let capturedPrompt = "";
      let capturedImageUrl = "";

      const mockFetch: import("../lib/ai").FetchFn = async (url: any, init: any) => {
        const urlStr = String(url);
        const body = init?.body ? JSON.parse(init.body) : {};

        if (urlStr.includes("/chat/completions") || body.messages) {
          const userMsg = body.messages.find((m: any) => m.role === "user");
          if (Array.isArray(userMsg?.content)) {
            const textPart = userMsg.content.find(
              (p: any) => p.type === "text",
            );
            const imgPart = userMsg.content.find(
              (p: any) => p.type === "image_url",
            );
            capturedPrompt = textPart?.text ?? "";
            capturedImageUrl = imgPart?.image_url?.url ?? "";
          }

          return new Response(
            JSON.stringify({
              id: "chatcmpl-mock",
              object: "chat.completion",
              choices: [
                {
                  message: {
                    role: "assistant",
                    content:
                      "Physical Layout: Directed acyclic graph with three tiers. Underlying Meaning: MapReduce execution graph.",
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("Unexpected request", { status: 404 });
      };

      // Create process-image SDK
      const imageExtSDK = createExtensionSDK("process-image", {
        namespace: "images",
        database: db,
        models: { connection: { fetchFn: mockFetch, timeoutMs: 2000 } },
        extensionName: "process-image",
        extensionDir: join(import.meta.dir, "../extensions/process-image"),
        messageBus: bus,
      });

      // Register process-image handlers on bus
      await setupProcessImage(imageExtSDK);

      // Create caller SDK (e.g. obsidian or another extension)
      const callerSDK = createExtensionSDK(
        "obsidian",
        "obsidian",
        db,
        undefined,
        undefined,
        undefined,
        bus,
      );

      // Create dummy image file
      const tempDir = mkdtempSync(join(tmpdir(), "img-msg-test-"));
      const imgPath = join(tempDir, "data_pipeline.png");
      writeFileSync(imgPath, "FAKE_IMAGE_BYTES_54321");

      // Verify file:can-process query
      const canProc = await callerSDK.messages.request("file:can-process", {
        filePath: imgPath,
      });
      expect(canProc.canProcess).toBe(true);
      expect(canProc.supportedBy).toBe("process-image");

      // Execute file:process request
      const response = await callerSDK.messages.request("file:process", {
        filePath: imgPath,
        fileType: "image",
        contextEntity: "Vault: Analytics",
        options: {
        },
      });

      expect(response.success).toBe(true);
      expect(response.title).toBe("data_pipeline.png");
      expect(response.description).toContain("MapReduce execution graph");
      expect(response.chunks.length).toBe(2);
      expect(response.chunks[0].chunk_type).toBe("synthetic");
      expect(response.chunks[0].text_content).toContain(
        "Directed acyclic graph with three tiers",
      );
      expect(response.chunks[1].chunk_type).toBe("synthetic");
      expect(response.chunks[1].text_content).toContain(
        "MapReduce execution graph",
      );

      // Verify prompt coverage
      expect(capturedPrompt).toContain("Physical layout and visual elements");
      expect(capturedPrompt).toContain("Underlying explanation and meaning");
      expect(capturedImageUrl).toContain("data:image/png;base64,");

      // Verify graph entity and edge
      expect(
        response.entities.some(
          (e) => e.name === "data_pipeline.png" && e.type === "Image",
        ),
      ).toBe(true);
      expect(
        response.edges.some(
          (e) =>
            e.source === "data_pipeline.png" &&
            e.target === "Vault: Analytics" &&
            e.relation === "CONTAINED_IN",
        ),
      ).toBe(true);
    });
  });

  describe("4. End-to-End Refactored Obsidian Extension Ingestion", () => {
    it("ingests images in Obsidian using cross-extension messaging and creates DB records", async () => {
      const bus = createMessageBus();
      const db = createTestDb();

      const mockFetch: import("../lib/ai").FetchFn = async (url: any, init: any) => {
        const urlStr = String(url);
        const body = init?.body ? JSON.parse(init.body) : {};

        if (urlStr.includes("/chat/completions") || body.messages) {
          return new Response(
            JSON.stringify({
              id: "chatcmpl-mock",
              object: "chat.completion",
              choices: [
                {
                  message: {
                    role: "assistant",
                    content:
                      "Physical Layout: Microservice boxes linked via Kafka bus. Underlying Meaning: Event-driven architecture.",
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("Unexpected request", { status: 404 });
      };

      // 1. Initialize process-image extension
      const imageExtSDK = createExtensionSDK("process-image", {
        namespace: "images",
        database: db,
        models: { connection: { fetchFn: mockFetch, timeoutMs: 2000 } },
        extensionName: "process-image",
        extensionDir: join(import.meta.dir, "../extensions/process-image"),
        messageBus: bus,
      });
      await setupProcessImage(imageExtSDK);

      // 2. Initialize obsidian extension
      const obsidianSDK = createExtensionSDK("obsidian parser", {
        namespace: "obsidian",
        database: db,
        models: { connection: { fetchFn: mockFetch, timeoutMs: 2000 } },
        extensionName: "obsidian parser",
        extensionDir: join(import.meta.dir, "../extensions/obsidian"),
        messageBus: bus,
      });

      const tempDir = mkdtempSync(join(tmpdir(), "obs-img-test-"));
      const imgPath = join(tempDir, "event_bus.png");
      writeFileSync(imgPath, "FAKE_IMAGE_BYTES_EVENT_BUS");

      // Verify parseImageFile delegates through messaging
      const parsedImage = await obsidianParseImageFile(imgPath, obsidianSDK);
      expect(parsedImage.imageTitle).toBe("event_bus.png");
      expect(parsedImage.description).toContain("Event-driven architecture");

      // Ingest image via obsidian
      const ingestResult = await ingestImageFile(
        imgPath,
        "Vault: CoreVault",
        obsidianSDK,
      );

      expect(ingestResult.imageTitle).toBe("event_bus.png");
      expect(ingestResult.chunksCreated).toBe(2);

      // Verify SQLite records
      const source = db
        .query<{ type: string; title: string }, []>(
          "SELECT type, title FROM sources WHERE title = 'event_bus.png'",
        )
        .get();
      expect(source?.type).toBe("image");

      const chunks = db
        .query<{
          chunk_index: number;
          chunk_type: string;
          text_content: string;
        }, []>(
          "SELECT chunk_index, chunk_type, text_content FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE title = 'event_bus.png') ORDER BY chunk_index ASC",
        )
        .all();
      expect(chunks.length).toBe(2);
      expect(chunks[0].chunk_type).toBe("synthetic");
      expect(chunks[0].text_content).toContain("Microservice boxes");
      expect(chunks[1].chunk_type).toBe("synthetic");
      expect(chunks[1].text_content).toContain("Event-driven architecture");

      // Verify Image entity and IN_SAME_VAULT edge returned in ingestResult
      expect(
        ingestResult.entities.some(
          (e) => e.name === "event_bus.png" && e.type === "Image",
        ),
      ).toBe(true);
      expect(
        ingestResult.edges.some(
          (e) =>
            e.source === "event_bus.png" &&
            e.target === "Vault: CoreVault" &&
            e.relation === "IN_SAME_VAULT",
        ),
      ).toBe(true);

      // Commit graph entities and edges
      obsidianSDK.graph.ingest({
        entities: [
          { name: "Vault: CoreVault", type: "Vault" },
          ...ingestResult.entities,
        ],
        edges: ingestResult.edges,
      });

      // Verify in entities table
      const entity = db
        .query<{ name: string; type: string }, []>(
          "SELECT name, type FROM entities WHERE name = 'event_bus.png'",
        )
        .get();
      expect(entity?.type).toBe("Image");
    });
  });

  describe("5. Bulk Image Parsing", () => {
    it("checks bulk capability via files:can-process", async () => {
      const bus = createMessageBus();
      const db = createTestDb();

      const imageExtSDK = createExtensionSDK(
        "process-image",
        "images",
        db,
        undefined,
        "process-image",
        join(import.meta.dir, "../extensions/process-image"),
        bus,
      );
      await setupProcessImage(imageExtSDK);

      const callerSDK = createExtensionSDK(
        "caller",
        "caller",
        db,
        undefined,
        undefined,
        undefined,
        bus,
      );

      const res = await callerSDK.messages.request("files:can-process", {
        filePaths: ["chart1.png", "photo.jpeg", "notes.md", "vector.svg"],
      });

      expect(res.canProcessAll).toBe(false);
      expect(res.results["chart1.png"].canProcess).toBe(true);
      expect(res.results["chart1.png"].supportedBy).toBe("process-image");
      expect(res.results["photo.jpeg"].canProcess).toBe(true);
      expect(res.results["vector.svg"].canProcess).toBe(true);
      expect(res.results["notes.md"].canProcess).toBe(false);
    });

    it("parses multiple images in bulk via files:process", async () => {
      const bus = createMessageBus();
      const db = createTestDb();
      const callLog: string[] = [];

      const mockFetch: import("../lib/ai").FetchFn = async (url: any, init: any) => {
        const urlStr = String(url);
        if (urlStr.includes("/chat/completions")) {
          callLog.push("chat");
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content:
                      "Physical Layout: Flow diagram. Underlying Meaning: Sequential processing logic.",
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      };

      const imageExtSDK = createExtensionSDK("process-image", {
        namespace: "images",
        database: db,
        models: { connection: { fetchFn: mockFetch } },
        extensionName: "process-image",
        extensionDir: join(import.meta.dir, "../extensions/process-image"),
        messageBus: bus,
      });
      await setupProcessImage(imageExtSDK);

      const callerSDK = createExtensionSDK(
        "caller",
        "caller",
        db,
        undefined,
        undefined,
        undefined,
        bus,
      );

      const tempDir = mkdtempSync(join(tmpdir(), "bulk-img-test-"));
      const img1 = join(tempDir, "img1.png");
      const img2 = join(tempDir, "img2.jpg");
      const img3 = join(tempDir, "img3.webp");
      writeFileSync(img1, "IMG1");
      writeFileSync(img2, "IMG2");
      writeFileSync(img3, "IMG3");

      const response = await callerSDK.messages.request("files:process", {
        filePaths: [img1, img2, img3],
        fileType: "image",
        contextEntity: "Vault: BulkTest",
      });

      expect(response.success).toBe(true);
      expect(response.totalProcessed).toBe(3);
      expect(response.results.length).toBe(3);

      for (let i = 0; i < 3; i++) {
        const item = response.results[i];
        expect(item.success).toBe(true);
        expect(item.chunks.length).toBe(2);
        expect(item.chunks[0].chunk_type).toBe("synthetic");
        expect(item.chunks[1].chunk_type).toBe("synthetic");
      }

      expect(callLog.filter((c) => c === "chat").length).toBe(3);
    });

    it("parses image batch in Obsidian using parseImageFilesBatch via files:process messaging", async () => {
      const bus = createMessageBus();
      const db = createTestDb();

      const mockFetch: import("../lib/ai").FetchFn = async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes("/chat/completions")) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content:
                      "Physical Layout: Bar chart. Underlying Meaning: Revenue growth.",
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      };

      const imageExtSDK = createExtensionSDK("process-image", {
        namespace: "images",
        database: db,
        models: { connection: { fetchFn: mockFetch } },
        extensionName: "process-image",
        extensionDir: join(import.meta.dir, "../extensions/process-image"),
        messageBus: bus,
      });
      await setupProcessImage(imageExtSDK);

      const obsidianSDK = createExtensionSDK(
        "obsidian",
        "obsidian",
        db,
        undefined,
        undefined,
        undefined,
        bus,
      );

      const tempDir = mkdtempSync(join(tmpdir(), "obsidian-bulk-"));
      const chart1 = join(tempDir, "revenue_q1.png");
      const chart2 = join(tempDir, "revenue_q2.png");
      writeFileSync(chart1, "CHART1");
      writeFileSync(chart2, "CHART2");

      const parsedBatch = await obsidianParseImageFilesBatch(
        [chart1, chart2],
        obsidianSDK,
      );

      expect(parsedBatch.length).toBe(2);
      expect(parsedBatch[0].imageTitle).toBe("revenue_q1.png");
      expect(parsedBatch[1].imageTitle).toBe("revenue_q2.png");
      expect(parsedBatch[0].contextualChunks.length).toBe(2);
      expect(parsedBatch[0].contextualChunks[0].chunk_type).toBe("synthetic");
      expect(parsedBatch[0].contextualChunks[1].chunk_type).toBe("synthetic");
    });
  });
});
