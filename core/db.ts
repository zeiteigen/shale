import db from "./db-init";

export interface Source {
  id: string;
  type: string;
  uri: string;
  origin: string;
  created_at: number;
  title: string;
  updated_at: number;
  hash: string;
}

export interface ChunkWithEmbedding {
  id?: number;
  source_id: string;
  chunk_index: number;
  text_content: string;
  embedding: number[]; // Float32Array also acceptable, but usually passed as number[] from JS
}

export interface Entity {
  id?: number;
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
    INSERT INTO sources (id, type, uri, origin, created_at, title, updated_at, hash)
    VALUES ($id, $type, $uri, $origin, $created_at, $title, $updated_at, $hash)
  `);

  stmt.run({
    $id: source.id,
    $type: source.type,
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
  const insertChunk = db.query<
    { id: number },
    { $source_id: string; $chunk_index: number; $text_content: string }
  >(`
    INSERT INTO chunks (source_id, chunk_index, text_content) 
    VALUES ($source_id, $chunk_index, $text_content)
    RETURNING id
  `);
  const insertVector = db.query(`
    INSERT INTO vector_index (rowid, embedding) 
    VALUES ($rowid, $embedding)
  `);

  const txn = db.transaction((items: ChunkWithEmbedding[]) => {
    for (const chunk of items) {
      const res = insertChunk.get({
        $source_id: chunk.source_id,
        $chunk_index: chunk.chunk_index,
        $text_content: chunk.text_content,
      });

      if (!res) continue;

      insertVector.run({
        $rowid: res.id,
        $embedding: new Uint8Array(new Float32Array(chunk.embedding).buffer),
      });
    }
  });

  txn(chunks);
}

// 3. Graph Data
export function addGraphData(entities: Entity[], edges: Edge[]) {
  const insertEntity = db.query<
    { id: number },
    { $name: string; $type: string }
  >(`
    INSERT INTO entities (name, type) 
    VALUES ($name, $type) 
    ON CONFLICT(name) DO UPDATE SET type = excluded.type 
    RETURNING id
  `);
  const insertEdge = db.query(`
    INSERT OR REPLACE INTO edges (source_entity_id, target_entity_id, relation, weight) 
    VALUES ($source, $target, $relation, $weight)
  `);

  const txn = db.transaction((ents: Entity[], edgs: Edge[]) => {
    const idMap = new Map<number, number>();

    for (const e of ents) {
      const res = insertEntity.get({ $name: e.name, $type: e.type });
      if (res) {
        if (e.id !== undefined) {
          idMap.set(e.id, res.id);
        }
        e.id = res.id;
      }
    }
    for (const e of edgs) {
      const sourceId = idMap.get(e.source_entity_id) ?? e.source_entity_id;
      const targetId = idMap.get(e.target_entity_id) ?? e.target_entity_id;
      insertEdge.run({
        $source: sourceId,
        $target: targetId,
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
export function searchSimilarChunks(
  queryEmbedding: number[],
  limit: number = 10,
) {
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
    $query: new Uint8Array(new Float32Array(queryEmbedding).buffer),
    $limit: limit,
  });
}

export function searchBM25(keyword: string, limit: number = 10) {
  const stmt = db.query(`
    SELECT 
      c.id, 
      c.source_id, 
      c.chunk_index,
      c.text_content,
      bm25(chunks_fts) AS score,
      snippet(chunks_fts, -1, '<b>', '</b>', '...', 10) AS preview
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    WHERE chunks_fts MATCH $keyword
    ORDER BY score
    LIMIT $limit
  `);

  return stmt.all({ $keyword: keyword, $limit: limit });
}
