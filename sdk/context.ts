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
}

export default ContextHydrator;
