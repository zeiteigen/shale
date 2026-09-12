import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createExtensionSDK, runWithSDK } from "../sdk";
import { discoverVaults } from "../extensions/obsidian/vault-finder";
import { parseNoteContent } from "../extensions/obsidian/parser";
import { dynamicChunkNote } from "../extensions/obsidian/chunker";
import {
  processVault,
  ingestFile,
  ingestImageFile,
  parseFile,
  parseImageFile,
  findImageFiles,
  describeImageWithChatModel,
  expandNoteWithChatModel,
} from "../extensions/obsidian/index";
import {
  countWords,
  calculateDynamicTargetTokens,
} from "../extensions/obsidian/parse-file";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  sqliteVec.load(db);

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
      FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE CASCADE
    ) STRICT;
  `);

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vector_index USING vec0(
      embedding float[4096]
    );
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
    CREATE TRIGGER IF NOT EXISTS chunks_vector_ad AFTER DELETE ON chunks BEGIN
      DELETE FROM vector_index WHERE rowid = old.id;
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

describe("Obsidian Plugin Architecture & Processing", () => {
  describe("1. Vault Discovery", () => {
    it("parses vaults from custom obsidian.json", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "obsidian-test-"));
      const fakeVault = join(tempDir, "my-vault");
      mkdirSync(fakeVault);

      const fakeConfig = join(tempDir, "obsidian.json");
      writeFileSync(
        fakeConfig,
        JSON.stringify({
          vaults: {
            v1: { path: fakeVault, ts: 12345, open: true },
            v2: { path: "/nonexistent/vault/path", ts: 0 },
          },
        }),
      );

      const vaults = discoverVaults(fakeConfig);
      expect(vaults.length).toBe(1);
      expect(vaults[0].name).toBe("my-vault");
      expect(vaults[0].path).toBe(fakeVault);
    });

    it("handles missing obsidian.json gracefully", () => {
      const vaults = discoverVaults("/tmp/nonexistent-obsidian-config.json");
      expect(vaults).toEqual([]);
    });
  });

  describe("2. Markdown Parsing & Reference Extraction", () => {
    it("extracts wikilinks, image embeds, and tags while stripping frontmatter", () => {
      const markdown = `---
category: Chemistry
tags:
- science
- compounds
---

# Alkanes

[[Alkanes]] are [[hydrocarbons|saturated hydrocarbons]].
See also [[Organic Chemistry#Naming]] and [[methane.md]].

Here is a diagram:
![[alkane_structure.png]]
And another format:
![Reaction](http://example.com/reaction.jpg)
`;

      const parsed = parseNoteContent(markdown, "Alkanes");

      expect(parsed.title).toBe("Alkanes");
      expect(parsed.body).toContain("# Alkanes");
      expect(parsed.body).not.toContain("category: Chemistry");

      // Wikilinks (excluding self-reference Alkanes, alias stripped, anchor stripped, .md stripped)
      expect(parsed.wikilinks).toContain("hydrocarbons");
      expect(parsed.wikilinks).toContain("Organic Chemistry");
      expect(parsed.wikilinks).toContain("methane");
      expect(parsed.wikilinks).not.toContain("Alkanes"); // Self reference excluded

      // Images
      expect(parsed.images).toContain("alkane_structure.png");
      expect(parsed.images).toContain("http://example.com/reaction.jpg");

      // Frontmatter tags
      expect(parsed.tags).toContain("science");
      expect(parsed.tags).toContain("compounds");
    });
  });

  describe("3. Dynamic Chunking", () => {
    it("treats short notes as atomic single chunks", () => {
      const shortNote = `This is a short atomic note defining legitimacy in political science.`;
      const chunks = dynamicChunkNote(shortNote, "Legitimacy");

      expect(chunks.length).toBe(1);
      expect(chunks[0].chunk_index).toBe(0);
      expect(chunks[0].heading).toBe("Legitimacy");
      expect(chunks[0].text_content).toBe(shortNote);
    });

    it("chunks moderate notes by H1 or H2 headings", () => {
      const moderateNote = `# Section 1
This is the first section with moderate length content discussing the introduction to classical liberalism.
It outlines key historical developments, political theories, and social philosophies.
We examine the origins of individual rights and constitutionalism across European intellectual history.

# Section 2
This is the second section explaining free markets, Adam Smith, and the division of labor.
It elaborates on economic models, trade networks, and modern international systems.
Market dynamics demonstrate how voluntary exchange creates economic prosperity and growth.

# Section 3
This is the conclusion summarizing international institutions and the rule of law.
Liberal internationalism suggests that constitutional democracies rarely go to war with one another.
We conclude with a synthesis of modern governance frameworks and multilateral treaties.`;

      const chunks = dynamicChunkNote(moderateNote, "Liberalism");
      // Requirement 1: Chunking should also chunk the entire note as Chunk 0
      expect(chunks.length).toBe(4);
      expect(chunks[0].chunk_index).toBe(0);
      expect(chunks[0].heading).toBe("Liberalism");
      expect(chunks[0].text_content).toBe(moderateNote.trim());
      expect(chunks[1].chunk_index).toBe(1);
      expect(chunks[1].heading).toContain("Section 1");
      expect(chunks[2].chunk_index).toBe(2);
      expect(chunks[2].heading).toContain("Section 2");
      expect(chunks[3].chunk_index).toBe(3);
      expect(chunks[3].heading).toContain("Section 3");
    });

    it("chunks large notes hierarchically by H2 and H3", () => {
      let largeContent = `## Overview\nIntroduction to the large document.\n\n`;
      for (let i = 1; i <= 3; i++) {
        largeContent += `## Chapter ${i}\n`;
        for (let j = 1; j <= 3; j++) {
          largeContent += `### Section ${i}.${j}\n` + "A".repeat(800) + "\n\n";
        }
      }

      const chunks = dynamicChunkNote(largeContent, "Large Spec");
      expect(chunks.length).toBeGreaterThan(5);
      // All chunks have valid sequential indices
      chunks.forEach((c, idx) => {
        expect(c.chunk_index).toBe(idx);
        expect(c.text_content.length).toBeGreaterThan(0);
      });
    });
  });

  describe("4. End-to-End Vault Processing via SDK", () => {
    it("processes vault notes, graph edges, and watermarks", async () => {
      const db = createTestDb();
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                object: "embedding",
                index: 0,
                embedding: new Array(1536).fill(0.01),
              },
              {
                object: "embedding",
                index: 1,
                embedding: new Array(1536).fill(0.02),
              },
            ],
            model: "mock-model",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const sdk = createExtensionSDK("obsidian parser", "obsidian", db, {
        fetchFn: mockFetch,
        timeoutMs: 1000,
      });

      // Create a test vault folder
      const vaultDir = mkdtempSync(join(tmpdir(), "vault-e2e-"));
      const vaultInfo = {
        id: "test-vault-id",
        path: vaultDir,
        name: "test-vault",
      };

      // 1. Create notes and an image file
      const noteA = join(vaultDir, "Alpha.md");
      const noteB = join(vaultDir, "Beta.md");
      const imgFile = join(vaultDir, "diagram.png");

      writeFileSync(
        noteA,
        `# Alpha Note\nThis note references [[Beta]] and features an image:\n![[diagram.png]]`,
      );
      writeFileSync(
        noteB,
        `# Beta Note\nThis is the target note defining beta mechanisms.`,
      );
      writeFileSync(imgFile, "FAKE_IMAGE_DATA_BYTES");

      // First run: process all files
      const result1 = await processVault(vaultInfo, sdk);

      expect(result1.notesProcessed).toBe(2);
      expect(result1.chunksCreated).toBeGreaterThanOrEqual(2);
      expect(result1.edgesCreated).toBeGreaterThanOrEqual(3);

      // Verify sources in database
      const sources = db
        .query<{
          type: string;
          title: string;
        }>("SELECT type, title FROM sources ORDER BY type ASC, title ASC")
        .all();

      // Should have markdown_note
      expect(sources.map((s) => s.type)).toContain("markdown_note");
      expect(sources.map((s) => s.title)).toContain("Alpha");
      expect(sources.map((s) => s.title)).toContain("Beta");

      // Verify Graph Edges
      const edges = db
        .query<{ source: string; target: string; relation: string }>(
          `
          SELECT s.name AS source, t.name AS target, e.relation
          FROM edges e
          JOIN entities s ON e.source_entity_id = s.id
          JOIN entities t ON e.target_entity_id = t.id
          ORDER BY e.relation ASC, s.name ASC
        `,
        )
        .all();

      // 1. IN_SAME_VAULT edges (connecting notes to "Vault: test-vault")
      const vaultEdges = edges.filter((e) => e.relation === "IN_SAME_VAULT");
      expect(
        vaultEdges.some(
          (e) => e.source === "Alpha" && e.target === "Vault: test-vault",
        ),
      ).toBe(true);
      expect(
        vaultEdges.some(
          (e) => e.source === "Beta" && e.target === "Vault: test-vault",
        ),
      ).toBe(true);

      // 2. REFERENCES edge (Alpha -> Beta)
      const refEdge = edges.find(
        (e) =>
          e.source === "Alpha" &&
          e.target === "Beta" &&
          e.relation === "REFERENCES",
      );
      expect(refEdge).toBeDefined();

      // Verify Watermark
      const watermark = sdk.state.getWatermark(`vault:${vaultDir}:mtime`);
      expect(watermark).not.toBeNull();
      expect(Number(watermark)).toBeGreaterThan(0);

      // Second run without modifications: delta check skips all files
      const result2 = await processVault(vaultInfo, sdk);
      expect(result2.notesProcessed).toBe(0);
      expect(result2.chunksCreated).toBe(0);

      // Modify Note A and verify only Note A is processed on third run
      const futureTime = (Date.now() + 5000) / 1000;
      utimesSync(noteA, futureTime, futureTime);

      const result3 = await processVault(vaultInfo, sdk);
      expect(result3.notesProcessed).toBe(1);
    });

    it("processes vault using ambient SDK scope without passing sdk parameter", async () => {
      const db = createTestDb();
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                object: "embedding",
                index: 0,
                embedding: new Array(1536).fill(0.05),
              },
            ],
            model: "mock-model",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const sdk = createExtensionSDK("obsidian parser", "obsidian", db, {
        fetchFn: mockFetch,
        timeoutMs: 1000,
      });

      const vaultDir = mkdtempSync(join(tmpdir(), "vault-ambient-"));
      const vaultInfo = {
        id: "ambient-vault-id",
        path: vaultDir,
        name: "ambient-vault",
      };

      const noteFile = join(vaultDir, "AmbientNote.md");
      writeFileSync(
        noteFile,
        "# Ambient Note\nThis note is processed via ambient SDK.",
      );

      // Run processVault with NO sdk parameter, wrapped in runWithSDK
      const result = await runWithSDK(sdk, async () => {
        return await processVault(vaultInfo);
      });

      expect(result.notesProcessed).toBe(1);
      expect(result.chunksCreated).toBe(1);

      const source = db
        .query<{
          title: string;
        }>("SELECT title FROM sources WHERE title = 'AmbientNote'")
        .get();
      expect(source?.title).toBe("AmbientNote");
    });
  });

  describe("5. Atomic File Processing & Ingestion Pipeline", () => {
    it("parseFile parses a file into metadata and contextual chunks without SDK", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "parse-test-"));
      const notePath = join(tempDir, "Quantum.md");
      writeFileSync(
        notePath,
        `---\ncategory: Physics\ntags:\n- science\n---\n# Quantum Computing\n[[Qubits]] and entanglement.\n`,
      );

      const parsed = await parseFile(notePath);
      expect(parsed.filePath).toBe(notePath);
      expect(parsed.noteTitle).toBe("Quantum");
      expect(parsed.noteUri).toBe(`file://${notePath}`);
      expect(parsed.updatedAt).toBeGreaterThan(0);
      expect(parsed.parsed.wikilinks).toContain("Qubits");
      expect(parsed.chunks.length).toBeGreaterThan(0);
      expect(parsed.contextualChunks.length).toBe(parsed.chunks.length);
      expect(parsed.contextualChunks[0].text_content).toContain(
        "Category: Physics",
      );
      expect(parsed.contextualChunks[0].text_content).toContain(
        "# Note: Quantum",
      );
    });

    it("ingestFile invokes parseFile and performs SDK ingestion", async () => {
      const db = createTestDb();
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                object: "embedding",
                index: 0,
                embedding: new Array(1536).fill(0.01),
              },
            ],
            model: "mock-model",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const sdk = createExtensionSDK("obsidian parser", "obsidian", db, {
        fetchFn: mockFetch,
        timeoutMs: 1000,
      });

      const tempDir = mkdtempSync(join(tmpdir(), "ingest-test-"));
      const notePath = join(tempDir, "IngestDoc.md");
      writeFileSync(
        notePath,
        `# Ingest Doc\nTesting direct ingestFile call referencing [[LinkedDoc]].`,
      );

      const result = await ingestFile(notePath, "Vault: TestVault", sdk);
      expect(result.filePath).toBe(notePath);
      expect(result.noteTitle).toBe("IngestDoc");
      expect(result.chunksCreated).toBe(1);
      expect(result.entities.some((e) => e.name === "IngestDoc")).toBe(true);
      expect(result.entities.some((e) => e.name === "LinkedDoc")).toBe(true);
      expect(
        result.edges.some(
          (e) => e.source === "IngestDoc" && e.target === "Vault: TestVault",
        ),
      ).toBe(true);
      expect(
        result.edges.some(
          (e) => e.source === "IngestDoc" && e.target === "LinkedDoc",
        ),
      ).toBe(true);

      // Verify inserted in DB
      const count = db
        .query<{
          count: number;
        }>("SELECT COUNT(*) as count FROM sources WHERE title = 'IngestDoc'")
        .get();
      expect(count?.count).toBe(1);
    });

    it("preserves stack trace order: processVault --> ingestFile --> parseFile", async () => {
      const db = createTestDb();
      const sdk = createExtensionSDK("obsidian parser", "obsidian", db);

      const tempDir = mkdtempSync(join(tmpdir(), "vault-stacktrace-"));
      const vaultInfo = {
        id: "stacktrace-vault",
        path: tempDir,
        name: "stacktrace-vault",
      };

      // Create a file and set permission to 000 so statSync succeeds but readFileSync throws inside parseFile
      const unreadableMd = join(tempDir, "Unreadable.md");
      writeFileSync(unreadableMd, "# Unreadable Note Content");
      chmodSync(unreadableMd, 0o000);

      const originalError = console.error;
      let capturedError: Error | null = null;
      console.error = (...args: any[]) => {
        for (const arg of args) {
          if (arg instanceof Error) {
            capturedError = arg;
          }
        }
      };

      try {
        await processVault(vaultInfo, sdk);
      } finally {
        chmodSync(unreadableMd, 0o666);
        console.error = originalError;
      }

      expect(capturedError).not.toBeNull();
      const stack = capturedError!.stack ?? "";
      expect(stack).toContain("parseFile");
      expect(stack).toContain("ingestFile");
      expect(stack).toContain("processVault");

      const parseIndex = stack.indexOf("parseFile");
      const ingestIndex = stack.indexOf("ingestFile");
      const vaultIndex = stack.indexOf("processVault");

      expect(parseIndex).toBeLessThan(ingestIndex);
      expect(ingestIndex).toBeLessThan(vaultIndex);
    });

    it("handles stub notes with only frontmatter or empty body cleanly without throwing", async () => {
      const db = createTestDb();
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                object: "embedding",
                index: 0,
                embedding: new Array(1536).fill(0.01),
              },
            ],
            model: "mock-model",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const sdk = createExtensionSDK("obsidian parser", "obsidian", db, {
        fetchFn: mockFetch,
        timeoutMs: 1000,
      });

      const tempDir = mkdtempSync(join(tmpdir(), "stub-test-"));
      const stubNotePath = join(tempDir, "alkyne.md");
      writeFileSync(stubNotePath, `---\ncategory:\n- Chemistry\n---\n`);

      const parsed = await parseFile(stubNotePath);
      expect(parsed.contextualChunks.length).toBe(1);
      expect(parsed.contextualChunks[0].text_content).toContain(
        "# Note: alkyne",
      );
      expect(parsed.contextualChunks[0].text_content).toContain(
        "Category: Chemistry",
      );

      // Ingestion must succeed without throwing "Cannot ingest source without any chunks."
      const result = await ingestFile(
        stubNotePath,
        "Vault: ChemistryVault",
        sdk,
      );
      expect(result.chunksCreated).toBe(1);
      expect(result.noteTitle).toBe("alkyne");

      // Also verify completely blank note
      const blankNotePath = join(tempDir, "Blank.md");
      writeFileSync(blankNotePath, "");
      const blankResult = await ingestFile(
        blankNotePath,
        "Vault: ChemistryVault",
        sdk,
      );
      expect(blankResult.chunksCreated).toBe(1);
      expect(blankResult.noteTitle).toBe("Blank");
    });
  });

  describe("6. Whole Note Chunking (Requirement 1)", () => {
    it("chunks entire note as Chunk 0 for both moderate and large notes", () => {
      const noteTitle = "Distributed Systems";
      const sampleText = `# Introduction
Distributed systems consist of autonomous nodes communicating via network protocols.
They solve fundamental challenges of scalability, fault tolerance, and geographic distribution across modern cloud infrastructure.
Decentralized nodes coordinate without a global shared clock.

# Consensus Algorithms
Raft and Paxos ensure agreement across nodes despite network partitions and arbitrary node crashes.
Leader election, log replication, and safety invariants form the core architectural mechanism.
State machine replication guarantees that all replicas execute state transitions in identical order.

# Data Replication
Eventual consistency allows high availability while sacrificing immediate linearizability.
Vector clocks and conflict-free replicated data types track causality across asynchronous concurrent events.`;

      const chunks = dynamicChunkNote(sampleText, noteTitle);

      // Chunk 0 must represent the entire note
      expect(chunks.length).toBe(4);
      expect(chunks[0].chunk_index).toBe(0);
      expect(chunks[0].heading).toBe(noteTitle);
      expect(chunks[0].level).toBe(0);
      expect(chunks[0].text_content).toBe(sampleText.trim());

      // Subsequent chunks represent the sections with contiguous indices
      expect(chunks[1].chunk_index).toBe(1);
      expect(chunks[1].heading).toContain("Introduction");
      expect(chunks[2].chunk_index).toBe(2);
      expect(chunks[2].heading).toContain("Consensus Algorithms");
      expect(chunks[3].chunk_index).toBe(3);
      expect(chunks[3].heading).toContain("Data Replication");
    });

    it("ensures atomic notes have Chunk 0 as the whole note without duplicates", () => {
      const atomicText =
        "CAP theorem states consistency, availability, partition tolerance trade-offs.";
      const chunks = dynamicChunkNote(atomicText, "CAP");
      expect(chunks.length).toBe(1);
      expect(chunks[0].chunk_index).toBe(0);
      expect(chunks[0].heading).toBe("CAP");
      expect(chunks[0].text_content).toBe(atomicText);
    });
  });

  describe("7. Multimodal Image Text Descriptions & Graph Edges (Requirement 2)", () => {
    it("generates detailed layout and conceptual descriptions using Chat model and embeds image", async () => {
      const db = createTestDb();
      let capturedChatPrompt = "";
      let capturedImageInput: any = null;

      const dualMockFetch: typeof fetch = async (url: any, init: any) => {
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
            capturedChatPrompt = textPart?.text ?? "";
            capturedImageInput = imgPart?.image_url?.url ?? "";
          } else {
            capturedChatPrompt = userMsg?.content ?? "";
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
                      "Physical Layout: Central node A with bidirectional links to nodes B and C. Legend in bottom right. Underlying Meaning: Depicts Byzantine fault tolerance voting architecture.",
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        // Embeddings endpoint
        const inputCount = Array.isArray(body.input) ? body.input.length : 1;
        return new Response(
          JSON.stringify({
            object: "list",
            data: Array.from({ length: inputCount }, (_, i) => ({
              object: "embedding",
              index: i,
              embedding: new Array(1536).fill(0.04),
            })),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const sdk = createExtensionSDK("obsidian parser", "obsidian", db, {
        fetchFn: dualMockFetch,
        timeoutMs: 2000,
      });

      const tempDir = mkdtempSync(join(tmpdir(), "img-test-"));
      const imgPath = join(tempDir, "architecture.png");
      writeFileSync(imgPath, "FAKE_IMAGE_BYTES_12345");

      const imgResult = await ingestImageFile(
        imgPath,
        "Vault: CloudVault",
        sdk,
      );
      expect(imgResult.imageTitle).toBe("architecture.png");
      expect(imgResult.chunksCreated).toBe(1);

      // Verify Chat model prompt covered both physical layout and underlying explanation/meaning
      expect(capturedChatPrompt).toContain(
        "Physical layout and visual elements",
      );
      expect(capturedChatPrompt).toContain(
        "Underlying explanation and meaning",
      );
      expect(capturedImageInput).toContain("data:image/png;base64,");

      // Verify Image entity and IN_SAME_VAULT edge
      expect(
        imgResult.entities.some(
          (e) => e.name === "architecture.png" && e.type === "Image",
        ),
      ).toBe(true);
      expect(
        imgResult.edges.some(
          (e) =>
            e.source === "architecture.png" &&
            e.target === "Vault: CloudVault" &&
            e.relation === "IN_SAME_VAULT",
        ),
      ).toBe(true);

      // Verify in SQLite database
      const source = db
        .query<{
          type: string;
          title: string;
        }>("SELECT type, title FROM sources WHERE title = 'architecture.png'")
        .get();
      expect(source?.type).toBe("image");

      const chunk = db
        .query<{
          text_content: string;
        }>(
          "SELECT text_content FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE title = 'architecture.png')",
        )
        .get();
      expect(chunk?.text_content).toContain("Physical Layout: Central node A");
      expect(chunk?.text_content).toContain("Byzantine fault tolerance");
    });

    it("connects notes to images with FEATURES_IMAGE edge when referenced in notes", async () => {
      const db = createTestDb();
      const mockFetch: typeof fetch = async (url: any, init: any) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        const inputCount = Array.isArray(body.input) ? body.input.length : 1;
        return new Response(
          JSON.stringify({
            object: "list",
            data: Array.from({ length: inputCount }, (_, i) => ({
              object: "embedding",
              index: i,
              embedding: new Array(1536).fill(0.01),
            })),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const sdk = createExtensionSDK("obsidian parser", "obsidian", db, {
        fetchFn: mockFetch,
        timeoutMs: 1000,
      });

      const tempDir = mkdtempSync(join(tmpdir(), "feat-img-test-"));
      const notePath = join(tempDir, "Overview.md");
      writeFileSync(
        notePath,
        `# Architecture Overview\nThis system diagram is shown below:\n![[system_flow.png]]\n`,
      );

      const result = await ingestFile(notePath, "Vault: MainVault", sdk);
      expect(
        result.entities.some(
          (e) => e.name === "system_flow.png" && e.type === "Image",
        ),
      ).toBe(true);
      expect(
        result.edges.some(
          (e) =>
            e.source === "Overview" &&
            e.target === "system_flow.png" &&
            e.relation === "FEATURES_IMAGE",
        ),
      ).toBe(true);
    });
  });

  describe("8. Chat Model Note Content Expansion (Requirement 3)", () => {
    it("expands atomic notes with Chat model and adds an expanded context chunk", async () => {
      const db = createTestDb();
      let capturedPrompt = "";

      const mockFetch: typeof fetch = async (url: any, init: any) => {
        const urlStr = String(url);
        const body = init?.body ? JSON.parse(init.body) : {};

        if (urlStr.includes("/chat/completions") || body.messages) {
          capturedPrompt = body.messages[0]?.content || "";
          return new Response(
            JSON.stringify({
              id: "chatcmpl-exp",
              object: "chat.completion",
              choices: [
                {
                  message: {
                    role: "assistant",
                    content:
                      "Semantic Elaboration: Legitimacy defines why citizens voluntarily adhere to state directives without coercion. Related to Max Weber's authority types: rational-legal, traditional, and charismatic.",
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const inputCount = Array.isArray(body.input) ? body.input.length : 1;
        return new Response(
          JSON.stringify({
            object: "list",
            data: Array.from({ length: inputCount }, (_, i) => ({
              object: "embedding",
              index: i,
              embedding: new Array(1536).fill(0.02),
            })),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const sdk = createExtensionSDK("obsidian parser", "obsidian", db, {
        fetchFn: mockFetch,
        timeoutMs: 1500,
      });

      const tempDir = mkdtempSync(join(tmpdir(), "expand-test-"));
      const notePath = join(tempDir, "Legitimacy.md");
      writeFileSync(
        notePath,
        `Legitimacy is the popular acceptance of an authority, governing regime, or law.`,
      );

      const parsed = await parseFile(notePath, sdk, {
        expandAtomicNotes: true,
      });
      expect(parsed.chunks.length).toBe(2);
      expect(parsed.chunks[0].chunk_index).toBe(0);
      expect(parsed.chunks[0].text_content).toContain(
        "Legitimacy is the popular acceptance",
      );
      expect(parsed.chunks[1].chunk_index).toBe(1);
      expect(parsed.chunks[1].heading).toBe("Legitimacy (Expanded Context)");
      expect(parsed.chunks[1].text_content).toContain(
        "Max Weber's authority types",
      );

      // Ingest note and check both chunks are embedded
      const ingestRes = await ingestFile(notePath, "Vault: PolSci", sdk, {
        expandAtomicNotes: true,
      });
      expect(ingestRes.chunksCreated).toBe(2);

      const storedChunks = db
        .query<{
          text_content: string;
        }>(
          "SELECT text_content FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE title = 'Legitimacy')",
        )
        .all();
      expect(storedChunks.length).toBe(2);
      expect(storedChunks[0].text_content).toContain(
        "Legitimacy is the popular acceptance",
      );
      expect(storedChunks[1].text_content).toContain(
        "Max Weber's authority types",
      );

      // Verify dynamic tokens requested in system prompt
      expect(capturedPrompt).toContain(
        "Target approximately 138 tokens for your expansion response based on the note's size.",
      );
    });

    it("expands only short notes under 250 words and skips notes with 250 or more words", async () => {
      const db = createTestDb();
      let chatCalls = 0;

      const mockFetch: typeof fetch = async (url: any, init: any) => {
        const urlStr = String(url);
        if (urlStr.includes("/chat/completions")) {
          chatCalls++;
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "Expanded concepts for short note.",
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", index: 0, embedding: new Array(1536).fill(0.01) }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const sdk = createExtensionSDK("obsidian parser", "obsidian", db, {
        fetchFn: mockFetch,
      });

      const tempDir = mkdtempSync(join(tmpdir(), "word-limit-test-"));

      // 1. Long note with 260 words (>= 250 words)
      const longWords = Array.from({ length: 260 }, (_, i) => `word${i}`).join(" ");
      const longNotePath = join(tempDir, "LongNote.md");
      writeFileSync(longNotePath, longWords);

      const parsedLong = await parseFile(longNotePath, sdk);
      // Long note must NOT be expanded
      expect(countWords(longWords)).toBe(260);
      expect(parsedLong.chunks.some((c) => c.heading?.includes("Expanded Context"))).toBe(false);
      expect(chatCalls).toBe(0);

      // 2. Note with exactly 250 words (>= 250 words)
      const exact250Words = Array.from({ length: 250 }, (_, i) => `term${i}`).join(" ");
      const exact250NotePath = join(tempDir, "Exact250Note.md");
      writeFileSync(exact250NotePath, exact250Words);

      const parsed250 = await parseFile(exact250NotePath, sdk);
      expect(countWords(exact250Words)).toBe(250);
      expect(parsed250.chunks.some((c) => c.heading?.includes("Expanded Context"))).toBe(false);
      expect(chatCalls).toBe(0);

      // 3. Short note with 50 words (< 250 words)
      const shortWords = Array.from({ length: 50 }, (_, i) => `concept${i}`).join(" ");
      const shortNotePath = join(tempDir, "ShortNote.md");
      writeFileSync(shortNotePath, shortWords);

      const parsedShort = await parseFile(shortNotePath, sdk);
      // Short note MUST be expanded
      expect(countWords(shortWords)).toBe(50);
      expect(parsedShort.chunks.some((c) => c.heading?.includes("Expanded Context"))).toBe(true);
      expect(chatCalls).toBe(1);
    });

    it("dynamically computes target tokens based on note size in the system prompt", async () => {
      const db = createTestDb();
      const capturedSystemPrompts: string[] = [];

      const mockFetch: typeof fetch = async (url: any, init: any) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        if (body.messages) {
          const sys = body.messages.find((m: any) => m.role === "system");
          if (sys) {
            capturedSystemPrompts.push(sys.content);
          }
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "Expanded content.",
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
      };

      const sdk = createExtensionSDK("obsidian parser", "obsidian", db, {
        fetchFn: mockFetch,
      });

      // Check helper calculations
      expect(countWords("")).toBe(0);
      expect(countWords("   \n\t  ")).toBe(0);
      expect(countWords("one two   three")).toBe(3);

      const tokens10 = calculateDynamicTargetTokens("a ".repeat(10));
      const tokens100 = calculateDynamicTargetTokens("a ".repeat(100));
      const tokens200 = calculateDynamicTargetTokens("a ".repeat(200));

      expect(tokens10).toBeLessThan(tokens100);
      expect(tokens100).toBeLessThan(tokens200);

      // Test system prompt injection for a 20-word note vs 120-word note
      await expandNoteWithChatModel(sdk, "Note20", "word ".repeat(20));
      await expandNoteWithChatModel(sdk, "Note120", "word ".repeat(120));

      expect(capturedSystemPrompts.length).toBe(2);
      expect(capturedSystemPrompts[0]).toContain(
        `Target approximately ${calculateDynamicTargetTokens("word ".repeat(20))} tokens`,
      );
      expect(capturedSystemPrompts[1]).toContain(
        `Target approximately ${calculateDynamicTargetTokens("word ".repeat(120))} tokens`,
      );
    });
  });

  describe("9. Decoupled Embedding Architecture (Requirement 4)", () => {
    it("allows note chunking/parsing to execute with zero embedding calls", async () => {
      let embeddingCallsMade = 0;

      const mockFetch: typeof fetch = async (url: any) => {
        if (String(url).includes("/embeddings")) {
          embeddingCallsMade++;
        }
        return new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
        });
      };

      const tempDir = mkdtempSync(join(tmpdir(), "decouple-test-"));
      const notePath = join(tempDir, "DecoupledNote.md");
      const noteContent = `# Decoupled Note
This note is parsed and chunked without any embedding calls during the note chunking/parsing phase.
This architecture guarantees that note chunking and parsing remains completely decoupled from embedding.
When running embedding models locally, separating text preparation from model execution is critical.

# Subtopic
The local embedding model is executed in a dedicated phase outside of note chunking and parsing.
This avoids constant model swapping between chat models and embedding models on local GPU memory.
Furthermore, batches of chunks can be embedded together rather than one note at a time.`;

      writeFileSync(notePath, noteContent);

      // parseFile performs parsing and chunking with ZERO embedding calls
      const parsed = await parseFile(notePath);
      // Chunk 0 is the whole note, Chunk 1 is Section 1, Chunk 2 is Section 2
      expect(parsed.chunks.length).toBe(3);
      expect(parsed.contextualChunks.length).toBe(3);
      expect(embeddingCallsMade).toBe(0);
    });

    it("supports passing precomputed embeddings into ingestFile to bypass embedder", async () => {
      const db = createTestDb();
      let embeddingCalls = 0;

      const mockFetch: typeof fetch = async () => {
        embeddingCalls++;
        return new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
        });
      };

      const sdk = createExtensionSDK("obsidian parser", "obsidian", db, {
        fetchFn: mockFetch,
      });

      const tempDir = mkdtempSync(join(tmpdir(), "precomputed-test-"));
      const notePath = join(tempDir, "Precomputed.md");
      writeFileSync(notePath, `# Precomputed Note\nUsing precomputed vectors.`);

      const customEmbedding = [new Array(4096).fill(0.123)];
      const result = await ingestFile(notePath, "Vault: TestVault", sdk, {
        embeddings: customEmbedding,
        expandAtomicNotes: false,
      });

      expect(result.chunksCreated).toBe(1);
      // No calls should have hit the mock embedding endpoint because precomputed embeddings were supplied
      expect(embeddingCalls).toBe(0);
    });

    it("enforces strict two-phase execution: all chat model requests complete before any embedding request starts", async () => {
      const db = createTestDb();
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
                    content: "Expanded content or description from chat model.",
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
                {
                  index: 0,
                  embedding: new Array(4096).fill(0.01),
                },
                {
                  index: 1,
                  embedding: new Array(4096).fill(0.02),
                },
                {
                  index: 2,
                  embedding: new Array(4096).fill(0.03),
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      };

      const sdk = createExtensionSDK("obsidian parser", "obsidian", db, {
        fetchFn: mockFetch,
      });

      const tempDir = mkdtempSync(join(tmpdir(), "twophase-vault-"));
      const vaultInfo = {
        id: "twophase-vault",
        path: tempDir,
        name: "twophase-vault",
      };

      // Create 2 atomic notes (triggering Chat model expansion)
      writeFileSync(
        join(tempDir, "Atomic1.md"),
        "# Atomic Note 1\nConcise definition.",
      );
      writeFileSync(
        join(tempDir, "Atomic2.md"),
        "# Atomic Note 2\nAnother concise definition.",
      );

      // Create 1 image (triggering Chat model image description)
      writeFileSync(
        join(tempDir, "diagram.png"),
        Buffer.from("fake-png-binary-content"),
      );

      const result = await processVault(vaultInfo, sdk);

      expect(result.notesProcessed).toBe(2);
      expect(result.imagesProcessed).toBe(1);

      // Verify that chat model requests happened
      const chatCalls = callLog.filter((c) => c === "chat");
      const embedCalls = callLog.filter((c) => c === "embedding");
      expect(chatCalls.length).toBeGreaterThanOrEqual(3); // 2 note expansions + 1 image description
      expect(embedCalls.length).toBeGreaterThanOrEqual(2); // note and image embeddings

      // Crucial assertion: All chat calls must happen strictly before the first embedding call
      const firstEmbedIndex = callLog.indexOf("embedding");
      const lastChatIndex = callLog.lastIndexOf("chat");

      expect(firstEmbedIndex).toBeGreaterThan(-1);
      expect(lastChatIndex).toBeGreaterThan(-1);
      expect(lastChatIndex).toBeLessThan(firstEmbedIndex);

      // Verify no interleaving (no chat calls after the first embedding call)
      const callsAfterFirstEmbed = callLog.slice(firstEmbedIndex);
      expect(callsAfterFirstEmbed.every((c) => c === "embedding")).toBe(true);
    });
  });
});
