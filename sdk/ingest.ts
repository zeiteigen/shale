import { Database } from "bun:sqlite";
import { randomUUIDv7 } from "bun";
import defaultDb from "../lib/db-init";
import { ensureGraphSchema } from "../lib/graph/schema";
import { excludedSourceId } from "../lib/knowledge/exclusions";
import { prepareSourceMemory, memoryChunks, contentFingerprint, validateMemory } from '../lib/memory/prepare';
import { recordMemory, memoryHash } from './memory/records';
import { compactMemoryHistory } from './memory/retention';
import type {
  IngestSourceAndChunksInput,
  IngestSourceAndChunksResult,
} from "./types";
import { sourceRefreshScope } from '../lib/memory/refresh-scope';
import { refineObservedMemory } from '../lib/memory/refine';
import { SourceMemoryStore } from './memory/store';

export class UnifiedIngestor {
  private readonly db: Database;
  readonly defaultNamespace: string;

  constructor(defaultNamespace: string = "default", database?: Database) {
    this.defaultNamespace = defaultNamespace;
    this.db = database ?? defaultDb;
    ensureGraphSchema(this.db);
  }

  /**
   * Atomically ingests a source document, its text chunks in one transaction.
   * If any part fails, all changes are rolled back.
   *
   * @param input Source metadata and array of chunks
   */
  sourceAndChunks(
    input: IngestSourceAndChunksInput,
  ): IngestSourceAndChunksResult {
    const { source, namespace = this.defaultNamespace } = input;
    const rawChunks = input.chunks;
    if (!rawChunks?.length) throw new Error('Cannot ingest source without any chunks.');
    let memory = input.memory ?? prepareSourceMemory(rawChunks, { title: source.title,
      structuredObservations:['browser_activity','browser_history','browser_bookmark','web_session'].includes(source.type) });
    validateMemory(memory);

    const skipped = (sourceId: string): IngestSourceAndChunksResult => ({
      sourceId, chunkIds: [], chunksCount: 0, skipped: "excluded",
    });
    const excludedId = excludedSourceId(this.db, source.id, source.uri);
    if (excludedId) return skipped(source.id ?? excludedId);

    if (!rawChunks || rawChunks.length === 0) {
      throw new Error("Cannot ingest source without any chunks.");
    }

    let sourceId = source.id ?? randomUUIDv7();
    const now = Date.now();
    const createdAt = source.created_at ?? now;
    const updatedAt = source.updated_at ?? now;

    // Compute deterministic content hash if not provided
    const fingerprint = source.hash ?? contentFingerprint(rawChunks);

    const insertSourceStmt = this.db.query(`
      INSERT INTO sources (id, type, uri, origin, created_at, title, updated_at, hash)
      VALUES ($id, $type, $uri, $origin, $created_at, $title, $updated_at, $hash)
      ON CONFLICT(id) DO UPDATE SET type=excluded.type,uri=excluded.uri,origin=excluded.origin,
        title=excluded.title,updated_at=excluded.updated_at,hash=excluded.hash
    `);

    const insertChunkStmt = this.db.query<
      { id: number },
      {
        $source_id: string;
        $chunk_index: number;
        $chunk_type: string;
        $text_content: string;
      }
    >(`
      INSERT INTO chunks (source_id, chunk_index, chunk_type, text_content)
      VALUES ($source_id, $chunk_index, $chunk_type, $text_content)
      RETURNING id
    `);

    const insertEntityStmt = this.db.query<
      { id: number },
      { $namespace: string; $name: string; $type: string }
    >(`
      INSERT INTO entities (namespace, name, type)
      VALUES ($namespace, $name, $type)
      ON CONFLICT(namespace, name) DO UPDATE SET type = excluded.type
      RETURNING id
    `);

    const linkChunkEntityStmt = this.db.query(`
      INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id)
      VALUES ($chunk_id, $entity_id)
    `);

    const txn = this.db.transaction(() => {
      const excludedId = excludedSourceId(this.db, source.id, source.uri);
      if (excludedId) return skipped(source.id ?? excludedId);
      // 0. Cleanly remove any previous chunks for this source URI
      const existing = this.db
        .query<{ id: string }, { $uri: string }>(
          "SELECT id FROM sources WHERE uri = $uri",
        )
        .get({ $uri: source.uri }) ?? this.db.query<{id:string},[string]>(`SELECT source_id AS id FROM graph_source_archives
          WHERE json_extract(snapshot,'$.source.uri')=? ORDER BY removed_at DESC LIMIT 1`).get(source.uri);
      if (existing) {
        if (!source.id) sourceId = existing.id;
        if (sourceId !== existing.id) this.db.query("DELETE FROM sources WHERE id = ?").run(existing.id);
      }
      const remembered = this.db.query<{fingerprint:string},[string]>('SELECT fingerprint FROM source_memories WHERE source_id=?').get(sourceId);
      const refreshing=sourceRefreshScope();
      const sameContent=remembered?.fingerprint === fingerprint && !!this.db.query('SELECT 1 FROM sources WHERE id=?').get(sourceId);
      if(sameContent && refreshing && (refreshing.sourceId===sourceId||refreshing.uri===source.uri)) {
        const current=new SourceMemoryStore(this.db).get(sourceId);
        memory=refineObservedMemory({summary:current.summary.text,summaryMethod:current.summary.method,
          snippets:current.snippets,coverage:current.coverage},memory,refreshing.mode);
        validateMemory(memory);
      }
      const hash=memoryHash(memory,fingerprint);
      if (sameContent && (!refreshing || (refreshing.sourceId!==sourceId&&refreshing.uri!==source.uri) ||
        this.db.query<{hash:string},[string]>('SELECT hash FROM sources WHERE id=?').get(sourceId)!.hash===hash)) {
        this.db.query('UPDATE sources SET title=?,uri=?,type=?,origin=? WHERE id=?').run(source.title,source.uri,source.type,source.origin,sourceId);
        this.db.query('INSERT INTO source_observations(source_id,fingerprint,captured_at,origin,availability,metadata) VALUES(?,?,?,?,?,?)')
          .run(sourceId,fingerprint,updatedAt,source.origin,'retained',JSON.stringify({captureOrigin:source.observation?.captureOrigin,quality:source.observation?.quality}));
        this.db.query(`DELETE FROM source_observations WHERE source_id=? AND id NOT IN
          (SELECT id FROM source_observations WHERE source_id=? ORDER BY id DESC LIMIT 32)`).run(sourceId,sourceId);
        const ids = this.db.query<{id:number},[string]>('SELECT id FROM chunks WHERE source_id=? ORDER BY chunk_index').all(sourceId).map(c=>c.id);
        return {sourceId,chunkIds:ids,chunksCount:ids.length};
      }
      this.db.query("DELETE FROM chunks WHERE source_id = ?").run(sourceId);
      // Freshness is about original content, not edits to its remembered summary.
      this.db.query('UPDATE source_memories SET fingerprint=? WHERE source_id=?').run(fingerprint,sourceId);
      this.db.query('INSERT INTO source_memory_write_intents VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET hash=excluded.hash').run(sourceId,hash);

      // 1. Insert or replace the source
      insertSourceStmt.run({
        $id: sourceId,
        $type: source.type,
        $uri: source.uri,
        $origin: source.origin,
        $created_at: createdAt,
        $title: source.title,
        $updated_at: updatedAt,
        $hash: hash,
      });
      this.db.query('DELETE FROM graph_source_archives WHERE source_id=?').run(sourceId);

      const chunkIds: number[] = [];
      const chunks = memoryChunks(memory).map((chunk,index)=>({...chunk,entity_names:index===0?undefined:
        rawChunks.find((raw,i)=>(raw.chunk_index??i)===memory.snippets[index-1]?.locator.originalChunkIndex)?.entity_names}));

      // 2. Insert chunks
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkIndex = chunk.chunk_index ?? i;

        const res = insertChunkStmt.get({
          $source_id: sourceId,
          $chunk_index: chunkIndex,
          $chunk_type: chunk.chunk_type ?? "verbatim",
          $text_content: chunk.text_content,
        });

        if (!res) {
          throw new Error(`Failed to insert chunk at index ${chunkIndex}`);
        }

        chunkIds.push(res.id);

        // 3. Optional entity linkage
        if (chunk.entity_names && chunk.entity_names.length > 0) {
          for (const entityName of chunk.entity_names) {
            const ent = insertEntityStmt.get({
              $namespace: namespace,
              $name: entityName,
              $type: "Concept",
            });
            if (ent) {
              linkChunkEntityStmt.run({
                $chunk_id: res.id,
                $entity_id: ent.id,
              });
            }
          }
        }
      }

      recordMemory(this.db,sourceId,fingerprint,memory,true,source.observation);
      this.db.query('DELETE FROM source_memory_write_intents WHERE source_id=?').run(sourceId);
      compactMemoryHistory(this.db,sourceId);
      this.db.query(`INSERT OR IGNORE INTO chunk_entities(chunk_id,entity_id)
        SELECT c.id,e.entity_id FROM chunks c JOIN source_entities e ON e.source_id=c.source_id WHERE c.source_id=?`).run(sourceId);

      return {
        sourceId,
        chunkIds,
        chunksCount: chunkIds.length,
      };
    });

    return txn();
  }
}

export default UnifiedIngestor;
