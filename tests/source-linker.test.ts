import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { isTExtensionManifest, type ExtensionManifest } from "../lib/extension";
import {
  createExtensionSDK,
  type ShaleSDK,
  type Source,
} from "../sdk";
import { findCandidatePairs } from "../extensions/source-linker/candidate-finder";
import {
  parseLLMResponse,
  buildAnalysisPrompt,
  analyzeSourcePairWithLLM,
} from "../extensions/source-linker/llm-analyzer";
import {
  commitLinksToGraph,
  processSourceLinks,
  WATERMARK_KEY,
} from "../extensions/source-linker/process-links";
import { run as runRecover } from "../extensions/source-linker/recover";
import { run as runMain } from "../extensions/source-linker/index";

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

  // FTS5
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text_content, 
      content='chunks', 
      content_rowid='id', 
      tokenize='porter'
    );
  `);

  db.run(`CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text_content) VALUES (new.id, new.text_content);
  END`);
  db.run(`CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text_content) VALUES ('delete', old.id, old.text_content);
  END`);
  db.run(`CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text_content) VALUES ('delete', old.id, old.text_content);
    INSERT INTO chunks_fts(rowid, text_content) VALUES (new.id, new.text_content);
  END`);

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

  // Edges with metadata
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

  return db;
}

function insertSourceWithChunk(
  db: Database,
  source: Source,
  chunkText: string,
  chunkId: number,
) {
  db.run(
    `INSERT INTO sources (id, type, uri, origin, created_at, title, updated_at, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      source.id,
      source.type,
      source.uri,
      source.origin,
      source.created_at,
      source.title,
      source.updated_at,
      source.hash,
    ],
  );

  db.run(
    `INSERT INTO chunks (id, source_id, chunk_index, text_content)
     VALUES (?, ?, ?, ?);`,
    [chunkId, source.id, 0, chunkText],
  );

}

describe("Source Linker Extension", () => {
  describe("1. Manifest & Configuration Validation", () => {
    it("has a valid manifest.json complying with ExtensionManifest", async () => {
      const manifestPath = join(
        import.meta.dir,
        "../extensions/source-linker/manifest.json",
      );
      const manifest = await Bun.file(manifestPath).json();
      expect(isTExtensionManifest(manifest)).toBe(true);
      expect(manifest.name).toBe("source-linker");
      expect(manifest.checkpoint_recover).toBe("recover.ts");
      expect(manifest.crons?.length).toBeGreaterThan(0);
    });

    it("has valid settings.json and settings.help.json schemas", async () => {
      const settingsPath = join(
        import.meta.dir,
        "../extensions/source-linker/settings.json",
      );
      const helpPath = join(
        import.meta.dir,
        "../extensions/source-linker/settings.help.json",
      );

      const settings = await Bun.file(settingsPath).json();
      const help = await Bun.file(helpPath).json();

      expect(help.extension).toBe("source-linker");
      expect(help.settings.candidatesPerChunk).toBeDefined();
      expect(help.settings.maxPairsPerRun).toBeDefined();

      for (const [key, value] of Object.entries(settings)) {
        expect(help.settings[key]).toBeDefined();
      }
    });
  });

  describe("2. Text Candidate Pair Discovery", () => {
    let db: Database;
    let sdk: ShaleSDK;

    beforeEach(() => {
      db = createTestDb();
      sdk = createExtensionSDK("source-linker", { namespace: "source-linker", database: db,
        extensionDir: join(import.meta.dir, "../extensions/source-linker") });
    });

    it("discovers textually related sources and ignores unrelated sources", async () => {
      const source1: Source = {
        id: "src-quantum-1",
        type: "markdown_note",
        uri: "file:///quantum1.md",
        origin: "obsidian",
        created_at: 1000,
        updated_at: 1000,
        title: "Quantum Computing Foundations",
        hash: "h1",
      };

      const source2: Source = {
        id: "src-quantum-2",
        type: "markdown_note",
        uri: "file:///quantum2.md",
        origin: "obsidian",
        created_at: 1100,
        updated_at: 1100,
        title: "Qubits and Entanglement",
        hash: "h2",
      };

      const source3: Source = {
        id: "src-cooking",
        type: "markdown_note",
        uri: "file:///sourdough.md",
        origin: "obsidian",
        created_at: 1200,
        updated_at: 1200,
        title: "Sourdough Bread Recipe",
        hash: "h3",
      };

      insertSourceWithChunk(
        db,
        source1,
        "Quantum superposition allows qubits to exist in multiple states.",
        1,
      );
      insertSourceWithChunk(
        db,
        source2,
        "Quantum superposition and entangled qubits display correlations across distance.",
        2,
      );
      insertSourceWithChunk(
        db,
        source3,
        "Flour, water, yeast, and salt fermented over 24 hours.",
        3,
      );

      const targetSources = [source1, source2, source3];
      const candidates = await findCandidatePairs(targetSources, sdk, { candidatesPerChunk: 5, maxPairsPerRun: 10 });

      expect(candidates.length).toBe(1);
      const pair = candidates[0];
      expect(
        (pair.sourceA.id === source1.id && pair.sourceB.id === source2.id) ||
          (pair.sourceA.id === source2.id && pair.sourceB.id === source1.id),
      ).toBe(true);
      expect(pair.textScore).toBeGreaterThan(0);
    });
  });

  describe("3. LLM Analysis & Response Parsing", () => {
    it("parses valid JSON response and extracts shouldLink, relation, reason, weight", () => {
      const raw = JSON.stringify({
        shouldLink: true,
        relation: "EXPANDS_UPON",
        reason:
          "Qubits and entanglement directly detail quantum state mechanics.",
        weight: 0.92,
      });

      const analysis = parseLLMResponse(raw);
      expect(analysis.shouldLink).toBe(true);
      expect(analysis.relation).toBe("EXPANDS_UPON");
      expect(analysis.reason).toContain("quantum state mechanics");
      expect(analysis.weight).toBe(0.92);
    });

    it("parses markdown fenced code block JSON", () => {
      const raw =
        "```json\n" +
        JSON.stringify({
          shouldLink: true,
          relation: "references",
          reason: "Direct citation of quantum principles.",
          weight: 0.85,
        }) +
        "\n```";

      const analysis = parseLLMResponse(raw);
      expect(analysis.shouldLink).toBe(true);
      expect(analysis.relation).toBe("REFERENCES");
      expect(analysis.reason).toBe("Direct citation of quantum principles.");
      expect(analysis.weight).toBe(0.85);
    });

    it("correctly identifies unlinked pairs", () => {
      const raw = JSON.stringify({
        shouldLink: false,
        relation: "NONE",
        reason: "These sources discuss completely unrelated subjects.",
        weight: 0.0,
      });

      const analysis = parseLLMResponse(raw);
      expect(analysis.shouldLink).toBe(false);
      expect(analysis.weight).toBe(0.0);
    });

    it("builds prompt with source metadata and text excerpts", () => {
      const pair = {
        sourceA: {
          id: "s1",
          title: "Quantum 101",
          type: "note",
          origin: "obsidian",
          created_at: 1,
          updated_at: 1,
          uri: "u1",
          hash: "h1",
        },
        sourceB: {
          id: "s2",
          title: "Quantum 102",
          type: "note",
          origin: "obsidian",
          created_at: 2,
          updated_at: 2,
          uri: "u2",
          hash: "h2",
        },
        textScore: 0.88,
        matchedChunkIds: [1, 2],
      };

      const prompt = buildAnalysisPrompt(
        pair,
        "Intro to qubits",
        "Advanced qubits",
      );
      expect(prompt).toContain("Quantum 101");
      expect(prompt).toContain("Quantum 102");
      expect(prompt).toContain("Intro to qubits");
      expect(prompt).toContain("Advanced qubits");
      expect(prompt).toContain("0.880");
      expect(prompt).toContain("entityResolutions");
      expect(prompt).toContain("coreferences");
    });

    it("parses and sanitizes grounded entity coreference clusters", () => {
      const analysis = parseLLMResponse(JSON.stringify({
        shouldLink: true,
        relation: "REFERENCES",
        reason: "Both sources discuss the same organization.",
        weight: 0.9,
        entityResolutions: [{
          canonicalName: "OpenAI",
          entityType: "Organization",
          mentionsA: ["OpenAI", " OpenAI "],
          mentionsB: ["OpenAI, Inc."],
          confidence: 1.4,
          reason: "The legal name and common name identify the same company.",
        }],
      }));

      expect(analysis.entityResolutions).toHaveLength(1);
      expect(analysis.entityResolutions[0].mentionsA).toEqual(["OpenAI"]);
      expect(analysis.entityResolutions[0].confidence).toBe(1);
    });
  });

  describe("4. End-to-End Pipeline & Graph Ingestion with Reasons", () => {
    let db: Database;
    let sdk: ShaleSDK;

    beforeEach(() => {
      db = createTestDb();
      sdk = createExtensionSDK("source-linker", { namespace: "source-linker", database: db,
        extensionDir: join(import.meta.dir, "../extensions/source-linker") });
    });

    it("creates canonical mention and alias coreference graph connections", () => {
      const edgesCommitted = commitLinksToGraph([{
        sourceIdA: "source-a",
        sourceTitleA: "AI Lab Notes",
        sourceIdB: "source-b",
        sourceTitleB: "Company Profile",
        relation: "RELATES_TO",
        reason: "The notes cover the profiled organization.",
        weight: 0.9,
        textScore: 0.86,
        entityResolutions: [{
          canonicalName: "OpenAI",
          entityType: "Organization",
          mentionsA: ["OpenAI"],
          mentionsB: ["OpenAI, Inc."],
          confidence: 0.96,
          reason: "Common and legal names refer to the same organization.",
        }],
      }], sdk, "source-linker", false);

      expect(edgesCommitted).toBe(4);
      const graphEdges = db.query<{ source: string; target: string; relation: string; metadata: string }, []>(`
        SELECT coalesce(s.display_name,s.name) AS source, coalesce(t.display_name,t.name) AS target, e.relation, e.metadata
        FROM edges e
        JOIN entities s ON s.id = e.source_entity_id
        JOIN entities t ON t.id = e.target_entity_id
        ORDER BY e.relation, s.name
      `).all();
      expect(graphEdges.filter((edge) => edge.relation === "MENTIONS_ENTITY")).toHaveLength(2);
      expect(graphEdges).toContainEqual(expect.objectContaining({
        source: "OpenAI, Inc.", target: "OpenAI", relation: "COREFERS_TO",
      }));
      const coreferenceMetadata = JSON.parse(
        graphEdges.find((edge) => edge.relation === "COREFERS_TO")!.metadata,
      );
      expect(coreferenceMetadata.confidence).toBe(0.96);
    });

    it("evaluates candidates, queries LLM, creates checkpoints, and ingests edges with reason metadata", async () => {
      const source1: Source = {
        id: "src-opt-1",
        type: "markdown_note",
        uri: "file:///gd.md",
        origin: "obsidian",
        created_at: 2000,
        updated_at: 2000,
        title: "Gradient Descent",
        hash: "h1",
      };

      const source2: Source = {
        id: "src-opt-2",
        type: "markdown_note",
        uri: "file:///adam.md",
        origin: "obsidian",
        created_at: 2100,
        updated_at: 2100,
        title: "Adam Optimizer",
        hash: "h2",
      };

      insertSourceWithChunk(
        db,
        source1,
        "Gradient descent optimizes loss functions by iteratively following negative gradients.",
        10,
      );
      insertSourceWithChunk(
        db,
        source2,
        "Adam combines momentum and adaptive learning rates with gradient descent.",
        20,
      );

      // Mock LLM query response
      const mockLLMResponse = JSON.stringify({
        shouldLink: true,
        relation: "EXPANDS_UPON",
        reason:
          "Adam optimizer is an adaptive extension of standard gradient descent.",
        weight: 0.95,
      });

      (sdk as any).queryLLM = async () => mockLLMResponse;

      const result = await processSourceLinks(sdk);

      expect(result.sourcesAnalyzed).toBe(2);
      expect(result.candidatePairsEvaluated).toBe(1);
      expect(result.linksCreated).toBe(1);
      expect(result.edgesCommitted).toBe(2); // Bidirectional
      expect(result.watermarkAdvancedTo).toBe(2100);

      // Verify entities in knowledge graph
      const entities = db
        .query<{ name: string; type: string }, []>(
          "SELECT name, type FROM entities ORDER BY name ASC",
        )
        .all();
      expect(entities.map((e) => e.name)).toEqual([
        "source:src-opt-1",
        "source:src-opt-2",
      ]);

      // Verify edges in knowledge graph
      const edges = db
        .query<{
          source_entity_id: number;
          target_entity_id: number;
          relation: string;
          weight: number;
          metadata: string;
        }, []>("SELECT relation, weight, metadata FROM edges")
        .all();

      expect(edges.length).toBe(2);
      expect(edges[0].relation).toBe("EXPANDS_UPON");
      expect(edges[0].weight).toBe(0.95);
      expect(edges[0].metadata).toBeDefined();

      const meta = JSON.parse(edges[0].metadata);
      expect(meta.reason).toBe(
        "Adam optimizer is an adaptive extension of standard gradient descent.",
      );
      expect(meta.textScore).toBeGreaterThan(0);

      // Verify watermark was persisted in extension_state
      const savedWatermark = sdk.state.getWatermark(WATERMARK_KEY);
      expect(savedWatermark).toBe("2100");

      // Verify subsequent run with no updates exits early
      const secondRun = await processSourceLinks(sdk);
      expect(secondRun.sourcesAnalyzed).toBe(0);
      expect(secondRun.linksCreated).toBe(0);
    });

    it("respects forceAll option to re-analyze all sources", async () => {
      const source1: Source = {
        id: "src-1",
        type: "note",
        uri: "file:///1.md",
        origin: "obsidian",
        created_at: 100,
        updated_at: 100,
        title: "Alpha",
        hash: "h1",
      };
      insertSourceWithChunk(db, source1, "Alpha content", 1);

      // Set existing watermark ahead of source1
      sdk.state.setWatermark("500", WATERMARK_KEY);

      (sdk as any).queryLLM = async () =>
        JSON.stringify({ shouldLink: false, relation: "NONE", reason: "None", weight: 0 });

      // Regular run skips source1
      const normalResult = await processSourceLinks(sdk);
      expect(normalResult.sourcesAnalyzed).toBe(0);

      // Force run includes source1
      const forceResult = await processSourceLinks(sdk, { forceAll: true });
      expect(forceResult.sourcesAnalyzed).toBe(1);
    });
  });

  describe("5. Crash Recovery & Checkpoints", () => {
    let db: Database;
    let sdk: ShaleSDK;

    beforeEach(() => {
      db = createTestDb();
      sdk = createExtensionSDK("source-linker", { namespace: "source-linker", database: db,
        extensionDir: join(import.meta.dir, "../extensions/source-linker") });
    });

    it("recovers uncommitted LLM link decisions via recover.ts", async () => {
      // Simulate crash: checkpoints exist in SQLite, but graph edges were not committed
      sdk.saveCheckpoint(
        {
          sourceA: { id: "src-arch", title: "System Architecture" },
          sourceB: { id: "src-db", title: "Database Design" },
          analysis: {
            shouldLink: true,
            relation: "DEPENDS_ON",
            reason: "System architecture specifies database design constraints.",
            weight: 0.91,
          },
          textScore: 0.85,
          updatedAt: 5000,
        },
        {
          id: "link_analysis:src-arch:src-db",
          key: "link_analysis:src-arch:src-db",
        },
      );

      expect(sdk.hasCheckpoints()).toBe(true);

      // Execute recovery
      const recResult = await runRecover(sdk);

      expect(recResult.recoveredCount).toBe(1);
      expect(recResult.edgesCommitted).toBe(2); // Bidirectional
      expect(recResult.watermarkAdvancedTo).toBe(0);

      // Checkpoints should now be resolved and cleared
      expect(sdk.hasCheckpoints()).toBe(false);

      // Verify edges were created in database
      const edges = db
        .query<{ relation: string; metadata: string }, []>(
          "SELECT relation, metadata FROM edges",
        )
        .all();
      expect(edges.length).toBe(2);
      expect(edges[0].relation).toBe("DEPENDS_ON");
      const meta = JSON.parse(edges[0].metadata);
      expect(meta.reason).toBe(
        "System architecture specifies database design constraints.",
      );

      // An individual decision does not prove completion of a discovery batch.
      expect(sdk.state.getWatermark(WATERMARK_KEY)).toBeNull();
    });
  });
});
