import { Database } from "bun:sqlite";
import { randomUUIDv7 } from "bun";
import defaultDb from "../lib/db-init";
import { ensureGraphSchema } from "../lib/graph/schema";
import { excludedSourceId } from "../lib/knowledge/exclusions";
import type {
  IngestSourceAndChunksInput,
  IngestSourceAndChunksResult,
} from "./types";

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
    const { source, chunks, namespace = this.defaultNamespace } = input;

    const skipped = (sourceId: string): IngestSourceAndChunksResult => ({
      sourceId, chunkIds: [], chunksCount: 0, skipped: "excluded",
    });
    const excludedId = excludedSourceId(this.db, source.id, source.uri);
    if (excludedId) return skipped(source.id ?? excludedId);

    if (!chunks || chunks.length === 0) {
      throw new Error("Cannot ingest source without any chunks.");
    }

    let sourceId = source.id ?? randomUUIDv7();
    const now = Date.now();
    const createdAt = source.created_at ?? now;
    const updatedAt = source.updated_at ?? now;

    // Compute deterministic content hash if not provided
    let hash = source.hash;
    if (!hash) {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(source.uri);
      for (const chunk of chunks) {
        hasher.update(chunk.text_content);
      }
      hash = hasher.digest("hex");
    }

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
      this.db.query("DELETE FROM chunks WHERE source_id = ?").run(sourceId);

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
