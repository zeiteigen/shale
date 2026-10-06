import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

import { join, resolve } from "node:path";
import { ensureCosineIndex } from "./cosine-index";
import { ensureGraphSchema } from "./graph/schema";
import { ensureVectorIndex } from "./embedding-storage";
import { getRootSetting } from "./settings";

const configuredPath = getRootSetting("SHALE_DB_PATH");
const db = new Database(process.env.SHALE_DB_PATH || (configuredPath
  ? resolve(import.meta.dir, "..", configuredPath)
  : join(import.meta.dir, "../production.db")));

db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA foreign_keys = ON;");

sqliteVec.load(db);

// Create Sources table
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
  CREATE INDEX IF NOT EXISTS idx_sources_hash ON sources(hash);
`);

// Initialize the Text Chunks table
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

// Safe migration for existing databases lacking chunk_type column
try {
  db.run(
    "ALTER TABLE chunks ADD COLUMN chunk_type TEXT NOT NULL DEFAULT 'verbatim' CHECK(chunk_type IN ('verbatim', 'synthetic'));",
  );
} catch {}


// Initialize the Vector Embeddings virtual table
// Note: Virtual tables do not use 'STRICT' mode
ensureVectorIndex(db);

ensureCosineIndex(db);

// Initialize BM25 virtual table with stopword and porter
db.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    text_content, 
    content='chunks', 
    content_rowid='id', 
    tokenize='porter'
);`);

// Triggers to keep index in-syncs automatically
db.run(`
  CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text_content) VALUES (new.id, new.text_content);
END;
`);

// FTS5 requires the special 'delete' command in the first column to remove index entries
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

// Vector virtual table triggers to prevent orphan embeddings on chunk delete or ID change
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

// Extension State Table (key-value store for watermarks, cursors, and persistent extension metadata)
db.run(`
  CREATE TABLE IF NOT EXISTS extension_state (
    extension_id TEXT NOT NULL,
    state_key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (extension_id, state_key)
  ) STRICT;
`);

// Checkpoints Table (temporary work queue for crash recovery)
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

// Graph

// 1. Entities Table (Nodes with namespacing)
db.run(`
  CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY,
    namespace TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    UNIQUE (namespace, name)
  ) STRICT;
`);

// 2. Edges Table (Relationships)
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

// Safe migration for existing databases lacking metadata column
try {
  db.run("ALTER TABLE edges ADD COLUMN metadata TEXT;");
} catch {}

// 3. Chunk_Entities Table (Provenance Bridge)
db.run(`
  CREATE TABLE IF NOT EXISTS chunk_entities (
    chunk_id INTEGER NOT NULL,
    entity_id INTEGER NOT NULL,
    PRIMARY KEY (chunk_id, entity_id),
    FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
    FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE
  ) STRICT;
`);

ensureGraphSchema(db);

export default db;
