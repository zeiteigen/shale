import db from "./db-init";
import { excludedSourceId } from "./knowledge/exclusions";

import { randomUUIDv7 } from "bun";
import { UnifiedIngestor } from "../sdk/ingest";

export { randomUUIDv7 as dbUUID };

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

export type ChunkType = "verbatim" | "synthetic";

export interface Chunk {
  id?: number;
  source_id: string;
  chunk_index: number;
  chunk_type?: ChunkType;
  text_content: string;
}

export interface Entity {
  id?: number;
  namespace?: string;
  name: string;
  type: string;
}

export interface ExtensionStateRecord {
  extension_id: string;
  state_key: string;
  value: string;
  updated_at: number;
}

export interface CheckpointRecord {
  id: string;
  extension_id: string;
  checkpoint_key: string;
  data: string;
  created_at: number;
  status: string;
}

export interface SaveCheckpointInput {
  id?: string;
  extension_id: string;
  checkpoint_key?: string;
  data: any;
  status?: string;
}

export interface IngestSourceAndChunksOptions {
  source: Source;
  chunks: {
    chunk_index?: number;
    chunk_type?: ChunkType;
    text_content: string;
  }[];
}

export interface Edge {
  source_entity_id: number;
  target_entity_id: number;
  relation: string;
  weight?: number;
  metadata?: string | Record<string, any>;
}

export interface ChunkEntityLink {
  chunk_id: number;
  entity_id: number;
}

// 1. Sources
export function addSource(source: Source) {
  if (excludedSourceId(db, source.id, source.uri)) return false;
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
  return true;
}

// 2. Chunks
export function addChunks(chunks: Chunk[]) {
  const grouped = Map.groupBy(chunks, chunk => chunk.source_id);
  for (const [sourceId, additions] of grouped) {
    const source = db.query<Source,[string]>('SELECT * FROM sources WHERE id=?').get(sourceId);
    if (!source) throw new Error(`Unknown source ${sourceId}`);
    const existing = db.query<Chunk,[string]>('SELECT * FROM chunks WHERE source_id=? ORDER BY chunk_index').all(sourceId);
    new UnifiedIngestor('default',db).sourceAndChunks({source:{...source,hash:undefined},chunks:[...existing,...additions]});
  }
}

// Legacy entry point shares the bounded source-memory writer.
export function addSourceWithChunks(options: IngestSourceAndChunksOptions): {sourceId:string;chunkIds:number[]} {
  return new UnifiedIngestor('default',db).sourceAndChunks(options);
}

// 4. Graph Data (with Entity Namespacing)
export function addGraphData(
  entitiesOrNamespace: Entity[] | string,
  edgesOrEntities: Edge[] | Entity[],
  maybeEdges?: Edge[],
) {
  let namespace = "default";
  let entities: Entity[];
  let edges: Edge[];

  if (typeof entitiesOrNamespace === "string") {
    namespace = entitiesOrNamespace;
    entities = edgesOrEntities as Entity[];
    edges = maybeEdges ?? [];
  } else {
    entities = entitiesOrNamespace;
    edges = edgesOrEntities as Edge[];
  }

  const insertEntity = db.query<
    { id: number },
    { $namespace: string; $name: string; $type: string }
  >(`
    INSERT INTO entities (namespace, name, type) 
    VALUES ($namespace, $name, $type) 
    ON CONFLICT(namespace, name) DO UPDATE SET type = excluded.type 
    RETURNING id
  `);
  let hasMetadata = false;
  try {
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(edges)")
      .all();
    hasMetadata = cols.some((c) => c.name === "metadata");
  } catch {}

  const insertEdge = hasMetadata
    ? db.query(`
        INSERT OR REPLACE INTO edges (source_entity_id, target_entity_id, relation, weight, metadata) 
        VALUES ($source, $target, $relation, $weight, $metadata)
      `)
    : db.query(`
        INSERT OR REPLACE INTO edges (source_entity_id, target_entity_id, relation, weight) 
        VALUES ($source, $target, $relation, $weight)
      `);

  const txn = db.transaction(
    (ents: Entity[], edgs: Edge[], defaultNs: string) => {
      const idMap = new Map<number, number>();

      for (const e of ents) {
        const ns = e.namespace || defaultNs;
        const res = insertEntity.get({
          $namespace: ns,
          $name: e.name,
          $type: e.type,
        });
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
        const params: Record<string, any> = {
          $source: sourceId,
          $target: targetId,
          $relation: e.relation,
          $weight: e.weight ?? 1.0,
        };
        if (hasMetadata) {
          params.$metadata =
            e.metadata !== undefined
              ? typeof e.metadata === "string"
                ? e.metadata
                : JSON.stringify(e.metadata)
              : null;
        }
        insertEdge.run(params);
      }
    },
  );

  txn(entities, edges, namespace);
}

// 5. Extension State (Persistent Key-Value Store for Watermarks & Cursors)
export function getExtensionState(
  extensionId: string,
  stateKey: string,
): string | null {
  const stmt = db.query<
    { value: string },
    { $extension_id: string; $state_key: string }
  >(`
    SELECT value FROM extension_state
    WHERE extension_id = $extension_id AND state_key = $state_key
  `);
  const res = stmt.get({ $extension_id: extensionId, $state_key: stateKey });
  return res ? res.value : null;
}

export function setExtensionState(
  extensionId: string,
  stateKey: string,
  value: string,
): void {
  const stmt = db.query(`
    INSERT INTO extension_state (extension_id, state_key, value, updated_at)
    VALUES ($extension_id, $state_key, $value, $updated_at)
    ON CONFLICT(extension_id, state_key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `);
  stmt.run({
    $extension_id: extensionId,
    $state_key: stateKey,
    $value: value,
    $updated_at: Date.now(),
  });
}

export function deleteExtensionState(
  extensionId: string,
  stateKey: string,
): boolean {
  const stmt = db.query(`
    DELETE FROM extension_state
    WHERE extension_id = $extension_id AND state_key = $state_key
  `);
  const result = stmt.run({ $extension_id: extensionId, $state_key: stateKey });
  return result.changes > 0;
}

export function getAllExtensionState(
  extensionId: string,
): ExtensionStateRecord[] {
  const stmt = db.query<ExtensionStateRecord, { $extension_id: string }>(`
    SELECT extension_id, state_key, value, updated_at
    FROM extension_state
    WHERE extension_id = $extension_id
    ORDER BY state_key ASC
  `);
  return stmt.all({ $extension_id: extensionId });
}

// 6. Checkpoints (Crash Recovery Work Queue)
export function saveCheckpoint(input: SaveCheckpointInput): CheckpointRecord {
  const id = input.id || randomUUIDv7();
  const serializedData =
    typeof input.data === "string" ? input.data : JSON.stringify(input.data);
  const checkpointKey = input.checkpoint_key || "default";
  const status = input.status || "queued";
  const createdAt = Date.now();

  const stmt = db.query(`
    INSERT INTO checkpoints (id, extension_id, checkpoint_key, data, created_at, status)
    VALUES ($id, $extension_id, $checkpoint_key, $data, $created_at, $status)
    ON CONFLICT(id) DO UPDATE SET
      extension_id = excluded.extension_id,
      checkpoint_key = excluded.checkpoint_key,
      data = excluded.data,
      created_at = excluded.created_at,
      status = excluded.status
  `);

  stmt.run({
    $id: id,
    $extension_id: input.extension_id,
    $checkpoint_key: checkpointKey,
    $data: serializedData,
    $created_at: createdAt,
    $status: status,
  });

  return {
    id,
    extension_id: input.extension_id,
    checkpoint_key: checkpointKey,
    data: serializedData,
    created_at: createdAt,
    status,
  };
}

export function getQueuedCheckpoints(extensionId: string): CheckpointRecord[] {
  const stmt = db.query<CheckpointRecord, { $extension_id: string }>(`
    SELECT id, extension_id, checkpoint_key, data, created_at, status
    FROM checkpoints
    WHERE extension_id = $extension_id AND status = 'queued'
    ORDER BY created_at ASC
  `);
  return stmt.all({ $extension_id: extensionId });
}

export function getAllCheckpoints(extensionId: string): CheckpointRecord[] {
  const stmt = db.query<CheckpointRecord, { $extension_id: string }>(`
    SELECT id, extension_id, checkpoint_key, data, created_at, status
    FROM checkpoints
    WHERE extension_id = $extension_id
    ORDER BY created_at ASC
  `);
  return stmt.all({ $extension_id: extensionId });
}

export function getCheckpoint(id: string): CheckpointRecord | null {
  const stmt = db.query<CheckpointRecord, { $id: string }>(`
    SELECT id, extension_id, checkpoint_key, data, created_at, status
    FROM checkpoints
    WHERE id = $id
  `);
  const res = stmt.get({ $id: id });
  return res || null;
}

export function hasQueuedCheckpoints(extensionId: string): boolean {
  const stmt = db.query<{ one: number }, { $extension_id: string }>(`
    SELECT 1 as one FROM checkpoints
    WHERE extension_id = $extension_id AND status = 'queued'
    LIMIT 1
  `);
  const res = stmt.get({ $extension_id: extensionId });
  return !!res;
}

export function deleteCheckpoint(idOrKey: string): boolean {
  const stmt = db.query(`
    DELETE FROM checkpoints
    WHERE id = $val OR checkpoint_key = $val
  `);
  const res = stmt.run({ $val: idOrKey });
  return res.changes > 0;
}

export function clearQueuedCheckpoints(extensionId: string): number {
  const stmt = db.query(`
    DELETE FROM checkpoints
    WHERE extension_id = $extension_id AND status = 'queued'
  `);
  const res = stmt.run({ $extension_id: extensionId });
  return res.changes;
}

export function clearAllCheckpoints(extensionId: string): number {
  const stmt = db.query(`
    DELETE FROM checkpoints
    WHERE extension_id = $extension_id
  `);
  const res = stmt.run({ $extension_id: extensionId });
  return res.changes;
}

export function updateCheckpointStatus(id: string, status: string): boolean {
  const stmt = db.query(`
    UPDATE checkpoints
    SET status = $status
    WHERE id = $id
  `);
  const res = stmt.run({ $id: id, $status: status });
  return res.changes > 0;
}

// 7. Chronological Context Hydration
export function getChronologicalChunks(
  sourceIdOrUri: string,
  limit: number = 20,
): Chunk[] {
  const stmt = db.query<
    Chunk,
    { $idOrUri: string; $limit: number }
  >(`
    SELECT * FROM (
      SELECT c.id, c.source_id, c.chunk_index, c.text_content
      FROM chunks c
      LEFT JOIN sources s ON c.source_id = s.id
      WHERE c.source_id = $idOrUri OR s.id = $idOrUri OR s.uri = $idOrUri
      ORDER BY c.chunk_index DESC
      LIMIT $limit
    )
    ORDER BY chunk_index ASC
  `);
  return stmt.all({ $idOrUri: sourceIdOrUri, $limit: limit });
}

// 7. Provenance Bridge
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

// 9. BM25 Search
export function searchBM25(keyword: string, limit: number = 10) {
  const tokens = keyword.match(/[\w\u00C0-\u024F]+/g);
  const sanitized =
    tokens && tokens.length > 0
      ? tokens.map((t) => `"${t}"`).join(" ")
      : `"${keyword.replace(/"/g, '""')}"`;

  const stmt = db.query(`
    SELECT 
      c.id, 
      c.source_id, 
      c.chunk_index,
      c.text_content,
      s.title AS source_title,
      s.uri AS source_uri,
      bm25(chunks_fts) AS score,
      snippet(chunks_fts, -1, '<mark>', '</mark>', '...', 15) AS preview
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    LEFT JOIN sources s ON c.source_id = s.id
    WHERE chunks_fts MATCH $keyword
    ORDER BY score
    LIMIT $limit
  `);

  return stmt.all({ $keyword: sanitized, $limit: limit });
}
