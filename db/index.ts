import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

const db = new Database("production.db");

db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA foreign_keys = ON;");

sqliteVec.load(db);


// Create Sources table
db.run(`
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    uri TEXT NOT NULL,
    origin TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    title TEXT NOT NULL,
    updated_at INT NOT NULL
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
    rowid INTEGER PRIMARY KEY,
    embedding float[4096]
  );
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

// Helpers

export interface Source {
  id: string;
  uri: string;
  origin: string;
  created_at: number;
  title: string;
  updated_at: number;
  hash: string;
}

export interface ChunkWithEmbedding {
  id: number;
  source_id: string;
  chunk_index: number;
  text_content: string;
  embedding: number[]; // Float32Array also acceptable, but usually passed as number[] from JS
}

export interface Entity {
  id: number;
  name: string;
  type: string;
}

export interface Edge {
  source_entity_id: number;
  target_entity_id: number;
  relation: string;
  weight?: number;
}

export interface ChunkEntityLink {
  chunk_id: number;
  entity_id: number;
}

// 1. Sources
export function addSource(source: Source) {
  const stmt = db.query(`
    INSERT INTO sources (id, uri, origin, created_at, title, updated_at, hash)
    VALUES ($id, $uri, $origin, $created_at, $title, $updated_at, $hash)
  `);
  
  stmt.run({
    $id: source.id,
    $uri: source.uri,
    $origin: source.origin,
    $created_at: source.created_at,
    $title: source.title,
    $updated_at: source.updated_at,
    $hash: source.hash,
  });
}

// 2. Chunks and Embeddings
export function addChunksWithEmbeddings(chunks: ChunkWithEmbedding[]) {
  const insertChunk = db.query(`
    INSERT INTO chunks (id, source_id, chunk_index, text_content) 
    VALUES ($id, $source_id, $chunk_index, $text_content)
  `);
  const insertVector = db.query(`
    INSERT INTO vector_index (rowid, embedding) 
    VALUES ($rowid, $embedding)
  `);

  const txn = db.transaction((items: ChunkWithEmbedding[]) => {
    for (const chunk of items) {
      insertChunk.run({
        $id: chunk.id,
        $source_id: chunk.source_id,
        $chunk_index: chunk.chunk_index,
        $text_content: chunk.text_content,
      });
      
      insertVector.run({
        $rowid: chunk.id,
        $embedding: new Float32Array(chunk.embedding),
      });
    }
  });
  
  txn(chunks);
}

// 3. Graph Data
export function addGraphData(entities: Entity[], edges: Edge[]) {
  const insertEntity = db.query(`
    INSERT OR IGNORE INTO entities (id, name, type) 
    VALUES ($id, $name, $type)
  `);
  const insertEdge = db.query(`
    INSERT OR REPLACE INTO edges (source_entity_id, target_entity_id, relation, weight) 
    VALUES ($source, $target, $relation, $weight)
  `);

  const txn = db.transaction((ents: Entity[], edgs: Edge[]) => {
    for (const e of ents) {
      insertEntity.run({ $id: e.id, $name: e.name, $type: e.type });
    }
    for (const e of edgs) {
      insertEdge.run({
        $source: e.source_entity_id,
        $target: e.target_entity_id,
        $relation: e.relation,
        $weight: e.weight ?? 1.0,
      });
    }
  });

  txn(entities, edges);
}

// 4. Provenance Bridge
export function linkChunksToEntities(links: ChunkEntityLink[]) {
  const insertLink = db.query(`
    INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id) 
    VALUES ($chunk_id, $entity_id)
  `);
  
  const txn = db.transaction((items: ChunkEntityLink[]) => {
    for (const link of items) {
      insertLink.run({ $chunk_id: link.chunk_id, $entity_id: link.entity_id });
    }
  });
  
  txn(links);
}

// 5. Vector Search
export function searchSimilarChunks(queryEmbedding: number[], limit: number = 10) {
  const stmt = db.query(`
    SELECT 
      c.id, 
      c.source_id, 
      c.chunk_index,
      c.text_content, 
      v.distance 
    FROM vector_index v
    JOIN chunks c ON c.id = v.rowid
    WHERE v.embedding MATCH $query AND k = $limit
    ORDER BY v.distance
  `);
  
  return stmt.all({
    $query: new Float32Array(queryEmbedding),
    $limit: limit,
  });
}

export default db;