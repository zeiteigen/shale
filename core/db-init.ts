import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

import { join } from "node:path";

const db = new Database(join(import.meta.dir, "/production.db"));

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
    FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE CASCADE
  ) STRICT;
`);

// Initialize the Vector Embeddings virtual table
// Note: Virtual tables do not use 'STRICT' mode
db.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS vector_index USING vec0(
    embedding float[4096]
  );
`);

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

// Graph

// 1. Entities Table (Nodes)
db.run(`
  CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL
  ) STRICT;
`);

// 2. Edges Table (Relationships)
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

export default db;
