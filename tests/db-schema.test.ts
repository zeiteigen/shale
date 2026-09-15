import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

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

  // Vector virtual table
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vector_index USING vec0(
      embedding float[4]
    );
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

  // FTS triggers
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

  // Vector triggers
  db.run(`
    CREATE TRIGGER IF NOT EXISTS chunks_vector_ad AFTER DELETE ON chunks BEGIN
      DELETE FROM vector_index WHERE rowid = old.id;
    END;
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS chunks_vector_au AFTER UPDATE ON chunks BEGIN
      DELETE FROM vector_index WHERE rowid = old.id AND old.id != new.id;
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

describe("Database Schema & Trigger Integrity", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  describe("Phase 1: Entity Namespacing", () => {
    it("allows different namespaces to store entities with the same name", () => {
      const insertEntity = db.query<
        { id: number },
        { $namespace: string; $name: string; $type: string }
      >(`
        INSERT INTO entities (namespace, name, type)
        VALUES ($namespace, $name, $type)
        ON CONFLICT(namespace, name) DO UPDATE SET type = excluded.type
        RETURNING id
      `);

      const techApple = insertEntity.get({
        $namespace: "tech",
        $name: "Apple",
        $type: "Company",
      })!;
      const cookingApple = insertEntity.get({
        $namespace: "cooking",
        $name: "Apple",
        $type: "Fruit",
      })!;

      expect(techApple.id).not.toBe(cookingApple.id);

      const all = db
        .query<{
          namespace: string;
          name: string;
          type: string;
        }>("SELECT namespace, name, type FROM entities ORDER BY id ASC")
        .all();

      expect(all).toEqual([
        { namespace: "tech", name: "Apple", type: "Company" },
        { namespace: "cooking", name: "Apple", type: "Fruit" },
      ]);
    });

    it("updates only the target namespace on conflict", () => {
      const insertEntity = db.query(`
        INSERT INTO entities (namespace, name, type)
        VALUES ($namespace, $name, $type)
        ON CONFLICT(namespace, name) DO UPDATE SET type = excluded.type
      `);

      insertEntity.run({
        $namespace: "tech",
        $name: "Apple",
        $type: "Company",
      });
      insertEntity.run({
        $namespace: "cooking",
        $name: "Apple",
        $type: "Fruit",
      });

      // Update tech Apple
      insertEntity.run({
        $namespace: "tech",
        $name: "Apple",
        $type: "Corporation",
      });

      const techRes = db
        .query<{
          type: string;
        }>("SELECT type FROM entities WHERE namespace = 'tech' AND name = 'Apple'")
        .get();
      const cookRes = db
        .query<{
          type: string;
        }>("SELECT type FROM entities WHERE namespace = 'cooking' AND name = 'Apple'")
        .get();

      expect(techRes?.type).toBe("Corporation");
      expect(cookRes?.type).toBe("Fruit");
    });
  });

  describe("Phase 1: Extension State Table", () => {
    it("isolates state between different extensions", () => {
      const upsert = db.query(`
        INSERT INTO extension_state (extension_id, state_key, value, updated_at)
        VALUES ($extension_id, $state_key, $value, $updated_at)
        ON CONFLICT(extension_id, state_key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `);

      upsert.run({
        $extension_id: "ext-1",
        $state_key: "watermark",
        $value: "100",
        $updated_at: 1,
      });
      upsert.run({
        $extension_id: "ext-2",
        $state_key: "watermark",
        $value: "200",
        $updated_at: 1,
      });

      const val1 = db
        .query<{
          value: string;
        }>("SELECT value FROM extension_state WHERE extension_id = 'ext-1' AND state_key = 'watermark'")
        .get();
      const val2 = db
        .query<{
          value: string;
        }>("SELECT value FROM extension_state WHERE extension_id = 'ext-2' AND state_key = 'watermark'")
        .get();

      expect(val1?.value).toBe("100");
      expect(val2?.value).toBe("200");
    });

    it("advances watermarks cleanly for an extension", () => {
      const upsert = db.query(`
        INSERT INTO extension_state (extension_id, state_key, value, updated_at)
        VALUES ($extension_id, $state_key, $value, $updated_at)
        ON CONFLICT(extension_id, state_key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `);

      upsert.run({
        $extension_id: "obsidian",
        $state_key: "cursor",
        $value: "50",
        $updated_at: 10,
      });
      upsert.run({
        $extension_id: "obsidian",
        $state_key: "cursor",
        $value: "150",
        $updated_at: 20,
      });

      const res = db
        .query<{
          value: string;
          updated_at: number;
        }>("SELECT value, updated_at FROM extension_state WHERE extension_id = 'obsidian' AND state_key = 'cursor'")
        .get();

      expect(res?.value).toBe("150");
      expect(res?.updated_at).toBe(20);
    });
  });

  describe("Phase 2: Virtual Table Synchronization & Orphan Prevention", () => {
    it("deletes vector embeddings automatically when parent source is deleted (cascade)", () => {
      // 1. Insert source
      db.run(`
        INSERT INTO sources (id, type, uri, origin, created_at, title, updated_at, hash)
        VALUES ('src-1', 'doc', 'test://doc1', 'local', 100, 'Doc 1', 100, 'h1');
      `);

      // 2. Insert chunk
      const chunkRes = db
        .query<{ id: number }>(
          `
        INSERT INTO chunks (source_id, chunk_index, text_content)
        VALUES ('src-1', 0, 'Hello vector world')
        RETURNING id;
      `,
        )
        .get()!;

      // 3. Insert vector
      const v = new Uint8Array(new Float32Array([1.0, 2.0, 3.0, 4.0]).buffer);
      db.run("INSERT INTO vector_index (rowid, embedding) VALUES (?, ?);", [
        chunkRes.id,
        v,
      ]);

      // Verify presence in chunks, fts, and vector_index
      const countChunksBefore = db
        .query<{ c: number }>("SELECT count(*) as c FROM chunks")
        .get()!.c;
      const countFtsBefore = db
        .query<{ c: number }>("SELECT count(*) as c FROM chunks_fts")
        .get()!.c;
      const countVecBefore = db
        .query<{ c: number }>("SELECT count(*) as c FROM vector_index")
        .get()!.c;

      expect(countChunksBefore).toBe(1);
      expect(countFtsBefore).toBe(1);
      expect(countVecBefore).toBe(1);

      // 4. Delete source -> cascades to chunks -> triggers chunks_vector_ad and chunks_ad
      db.run("DELETE FROM sources WHERE id = 'src-1';");

      const countChunksAfter = db
        .query<{ c: number }>("SELECT count(*) as c FROM chunks")
        .get()!.c;
      const countFtsAfter = db
        .query<{ c: number }>("SELECT count(*) as c FROM chunks_fts")
        .get()!.c;
      const countVecAfter = db
        .query<{ c: number }>("SELECT count(*) as c FROM vector_index")
        .get()!.c;

      expect(countChunksAfter).toBe(0);
      expect(countFtsAfter).toBe(0);
      expect(countVecAfter).toBe(0); // Vector orphan prevented!
    });

    it("deletes vector embedding when a chunk is deleted directly", () => {
      db.run(`
        INSERT INTO sources (id, type, uri, origin, created_at, title, updated_at, hash)
        VALUES ('src-2', 'doc', 'test://doc2', 'local', 100, 'Doc 2', 100, 'h2');
      `);

      const chunk = db
        .query<{ id: number }>(
          `
        INSERT INTO chunks (source_id, chunk_index, text_content)
        VALUES ('src-2', 0, 'Direct chunk delete')
        RETURNING id;
      `,
        )
        .get()!;

      const v = new Uint8Array(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer);
      db.run("INSERT INTO vector_index (rowid, embedding) VALUES (?, ?);", [
        chunk.id,
        v,
      ]);

      expect(
        db.query<{ c: number }>("SELECT count(*) as c FROM vector_index").get()!
          .c,
      ).toBe(1);

      db.run("DELETE FROM chunks WHERE id = ?;", [chunk.id]);

      expect(
        db.query<{ c: number }>("SELECT count(*) as c FROM vector_index").get()!
          .c,
      ).toBe(0);
    });

    it("keeps FTS in sync on update", () => {
      db.run(`
        INSERT INTO sources (id, type, uri, origin, created_at, title, updated_at, hash)
        VALUES ('src-3', 'doc', 'test://doc3', 'local', 100, 'Doc 3', 100, 'h3');
      `);

      const chunk = db
        .query<{ id: number }>(
          `
        INSERT INTO chunks (source_id, chunk_index, text_content)
        VALUES ('src-3', 0, 'Original text')
        RETURNING id;
      `,
        )
        .get()!;

      db.run("UPDATE chunks SET text_content = 'Updated text' WHERE id = ?;", [
        chunk.id,
      ]);

      const ftsMatchesOld = db
        .query("SELECT * FROM chunks_fts WHERE chunks_fts MATCH 'Original'")
        .all();
      const ftsMatchesNew = db
        .query("SELECT * FROM chunks_fts WHERE chunks_fts MATCH 'Updated'")
        .all();
      expect(ftsMatchesOld.length).toBe(0);
      expect(ftsMatchesNew.length).toBe(1);
    });

    describe("Checkpoints Table", () => {
      it("stores and retrieves checkpoints in STRICT mode", () => {
        db.query(`
          INSERT INTO checkpoints (id, extension_id, checkpoint_key, data, created_at, status)
          VALUES ('cp-1', 'ext-1', 'chunk-progress', '{"offset": 100}', 123456789, 'queued')
        `).run();

        const res = db
          .query<{
            id: string;
            extension_id: string;
            checkpoint_key: string;
            data: string;
            created_at: number;
            status: string;
          }>("SELECT * FROM checkpoints WHERE id = 'cp-1'")
          .get()!;

        expect(res).toBeDefined();
        expect(res.id).toBe("cp-1");
        expect(res.extension_id).toBe("ext-1");
        expect(res.checkpoint_key).toBe("chunk-progress");
        expect(JSON.parse(res.data)).toEqual({ offset: 100 });
        expect(res.status).toBe("queued");
      });

      it("enforces PRIMARY KEY constraint on id", () => {
        db.query(`
          INSERT INTO checkpoints (id, extension_id, checkpoint_key, data, created_at, status)
          VALUES ('cp-unique', 'ext-1', 'k1', 'data1', 100, 'queued')
        `).run();

        expect(() => {
          db.query(`
            INSERT INTO checkpoints (id, extension_id, checkpoint_key, data, created_at, status)
            VALUES ('cp-unique', 'ext-1', 'k2', 'data2', 200, 'queued')
          `).run();
        }).toThrow();
      });
    });

    describe("Chunks Table chunk_type", () => {
      beforeEach(() => {
        db.run(`
          INSERT INTO sources (id, type, uri, origin, created_at, title, updated_at, hash)
          VALUES ('src-chunk-type', 'doc', 'test://chunk-type', 'local', 100, 'Doc Chunk Type', 100, 'h-ct');
        `);
      });

      it("defaults chunk_type to 'verbatim' when omitted", () => {
        db.run(`
          INSERT INTO chunks (source_id, chunk_index, text_content)
          VALUES ('src-chunk-type', 0, 'Default verbatim text');
        `);

        const chunk = db
          .query<{ chunk_type: string }>(
            "SELECT chunk_type FROM chunks WHERE source_id = 'src-chunk-type'",
          )
          .get();
        expect(chunk?.chunk_type).toBe("verbatim");
      });

      it("allows explicitly specifying 'verbatim' and 'synthetic'", () => {
        db.run(`
          INSERT INTO chunks (source_id, chunk_index, chunk_type, text_content)
          VALUES ('src-chunk-type', 1, 'verbatim', 'Explicit verbatim text');
        `);
        db.run(`
          INSERT INTO chunks (source_id, chunk_index, chunk_type, text_content)
          VALUES ('src-chunk-type', 2, 'synthetic', 'Explicit synthetic summary');
        `);

        const chunks = db
          .query<{ chunk_index: number; chunk_type: string }>(
            "SELECT chunk_index, chunk_type FROM chunks WHERE source_id = 'src-chunk-type' AND chunk_index IN (1, 2) ORDER BY chunk_index ASC",
          )
          .all();
        expect(chunks).toEqual([
          { chunk_index: 1, chunk_type: "verbatim" },
          { chunk_index: 2, chunk_type: "synthetic" },
        ]);
      });

      it("rejects invalid chunk_type values", () => {
        expect(() => {
          db.query(
            "INSERT INTO chunks (source_id, chunk_index, chunk_type, text_content) VALUES ('src-chunk-type', 3, 'invalid_type', 'Bad chunk')",
          ).run();
        }).toThrow();
      });
    });
  });
});

