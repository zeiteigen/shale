import type { HydratedChunk, ShaleSDK } from "@shale/sdk";

/** Candidate batches can outlive edits to their sources. Read their pinned revision. */
export function linkContext(sdk: ShaleSDK, sourceId: string, hash: string, limit: number) {
  const revision = sdk.database.query<{ id: number }, [string, string]>(
    "SELECT id FROM graph_source_revisions WHERE source_id=? AND hash=?",
  ).get(sourceId, hash);
  if (!revision) throw new Error(`Missing source-linker revision for ${sourceId}`);
  const chunks = sdk.database.query<Pick<HydratedChunk, "chunk_index" | "text_content">, [number, number]>(`
    SELECT chunk_index, text_content FROM (
      SELECT chunk_index, text_content FROM graph_revision_chunks
      WHERE revision_id=? ORDER BY chunk_index DESC LIMIT ?
    ) ORDER BY chunk_index ASC
  `).all(revision.id, limit);
  return { chunks, combinedText: chunks.map(chunk => chunk.text_content).join("\n\n") };
}
