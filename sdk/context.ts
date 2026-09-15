import { Database } from "bun:sqlite";
import defaultDb from "../lib/db-init";
import type { HydratedChunk, HydratedContext } from "./types";

export class ContextHydrator {
  private readonly db: Database;

  constructor(database?: Database) {
    this.db = database ?? defaultDb;
  }

  /**
   * Retrieves the most recent text chunks for a given source identifier (id or uri)
   * ordered chronologically (by chunk_index ASC).
   *
   * @param sourceIdOrUri The unique source ID or URI (e.g., chat thread URI)
   * @param limit Maximum number of recent chunks to retrieve (default: 20)
   */
  getRecentChunks(sourceIdOrUri: string, limit: number = 20): HydratedChunk[] {
    const stmt = this.db.query<
      HydratedChunk,
      { $idOrUri: string; $limit: number }
    >(`
      SELECT * FROM (
        SELECT c.id, c.source_id, c.chunk_index, c.chunk_type, c.text_content
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

  /**
   * Hydrates conversation or document context for an external source.
   * Returns metadata, the ordered chunks, and a concatenated text block for prompt engineering.
   *
   * @param sourceIdOrUri The unique source ID or URI
   * @param limit Maximum number of recent chunks to retrieve (default: 20)
   */
  hydrate(sourceIdOrUri: string, limit: number = 20): HydratedContext {
    const chunks = this.getRecentChunks(sourceIdOrUri, limit);

    // Fetch source details if available
    const sourceStmt = this.db.query<
      { id: string; uri: string; title: string },
      { $idOrUri: string }
    >(`
      SELECT id, uri, title FROM sources
      WHERE id = $idOrUri OR uri = $idOrUri
      LIMIT 1
    `);
    const sourceMeta = sourceStmt.get({ $idOrUri: sourceIdOrUri });

    const sourceId = sourceMeta?.id ?? (chunks[0]?.source_id || sourceIdOrUri);
    const combinedText = chunks.map((c) => c.text_content).join("\n\n");

    return {
      source_id: sourceId,
      uri: sourceMeta?.uri,
      title: sourceMeta?.title,
      chunks,
      combinedText,
    };
  }

  /**
   * Retrieves sources from the database with optional filtering.
   *
   * @param options Optional filters (since timestamp, origin, type, limit)
   */
  getSources(options?: import("./types").GetSourcesOptions): import("./types").Source[] {
    let sql = `
      SELECT id, type, uri, origin, created_at, title, updated_at, hash
      FROM sources
      WHERE 1 = 1
    `;
    const params: Record<string, any> = {};

    if (options?.since !== undefined) {
      sql += ` AND updated_at > $since`;
      params.$since = options.since;
    }
    if (options?.origin) {
      sql += ` AND origin = $origin`;
      params.$origin = options.origin;
    }
    if (options?.type) {
      sql += ` AND type = $type`;
      params.$type = options.type;
    }

    sql += ` ORDER BY updated_at ASC`;

    if (options?.limit) {
      sql += ` LIMIT $limit`;
      params.$limit = options.limit;
    }

    return this.db.query<import("./types").Source, any>(sql).all(params);
  }

  /**
   * Retrieves all sources in the database.
   */
  getAllSources(): import("./types").Source[] {
    return this.getSources();
  }

  /**
   * Retrieves a single source by ID or URI.
   *
   * @param idOrUri Unique source ID or URI
   */
  getSource(idOrUri: string): import("./types").Source | null {
    const stmt = this.db.query<import("./types").Source, { $idOrUri: string }>(`
      SELECT id, type, uri, origin, created_at, title, updated_at, hash
      FROM sources
      WHERE id = $idOrUri OR uri = $idOrUri
      LIMIT 1
    `);
    return stmt.get({ $idOrUri: idOrUri }) ?? null;
  }
}

export default ContextHydrator;
