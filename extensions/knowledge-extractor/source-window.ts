import type { ShaleSDK } from "@shale/sdk";
import type { ExtractionChunk, ExtractionCursor } from "./types";

export const extractionCursorKey = (revisionId: number) => `extraction-cursor:${revisionId}`;

/** Read a bounded, resumable window without declaring a source prefix complete. */
export function sourceWindow(sdk: ShaleSDK, revisionId: number, sourceType: string, maximum: number) {
  const saved = sdk.state.get(extractionCursorKey(revisionId));
  const cursor: ExtractionCursor = saved ? JSON.parse(saved) : { chunkIndex: 0, offset: 0 };
  const sqlOffset = cursor.codePointOffset ?? cursor.offset;
  if (![cursor.chunkIndex, cursor.offset, sqlOffset].every(value => Number.isSafeInteger(value) && value >= 0))
    throw new Error("Invalid knowledge extraction cursor");
  const chunks: ExtractionChunk[] = [];
  if (sourceType === "image") return { chunks, cursor, nextCursor: null };
  const statement = sdk.database.prepare<{ chunk_index: number; text_content: string; length: number }, [number, number, number, number, number]>(`
    SELECT chunk_index,length(text_content) AS length,
      substr(text_content,CASE WHEN chunk_index=? THEN ?+1 ELSE 1 END,?) AS text_content
    FROM graph_revision_chunks WHERE revision_id=? AND chunk_type='verbatim' AND chunk_index>=?
    ORDER BY chunk_index`);
  try {
    const stored = statement.iterate(cursor.chunkIndex, sqlOffset, maximum, revisionId, cursor.chunkIndex);
    let remaining = maximum;
    for (const chunk of stored) {
      const start = chunk.chunk_index === cursor.chunkIndex ? cursor.offset : 0;
      const sqlStart = chunk.chunk_index === cursor.chunkIndex ? sqlOffset : 0;
      const characters = Array.from(chunk.text_content).slice(0, remaining);
      const text_content = characters.join("");
      if (text_content) chunks.push({ chunk_index: chunk.chunk_index, text_content, start });
      remaining -= characters.length;
      if (remaining) continue;
      if (sqlStart + characters.length < chunk.length)
        return { chunks, cursor, nextCursor: { chunkIndex: chunk.chunk_index, offset: start + text_content.length,
          codePointOffset: sqlStart + characters.length } };
      const next = sdk.database.query<{ chunk_index: number }, [number, number]>(`
        SELECT chunk_index FROM graph_revision_chunks WHERE revision_id=? AND chunk_type='verbatim' AND chunk_index>?
        ORDER BY chunk_index LIMIT 1`).get(revisionId, chunk.chunk_index);
      return { chunks, cursor, nextCursor: next ? { chunkIndex: next.chunk_index, offset: 0 } : null };
    }
    return { chunks, cursor, nextCursor: null };
  } finally {
    statement.finalize();
  }
}
