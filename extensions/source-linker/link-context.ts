import type { HydratedChunk, ShaleSDK } from "@shale/sdk";

/** Candidate batches can outlive edits to their sources. Read their pinned revision. */
export function linkContext(sdk: ShaleSDK, sourceId: string, hash: string, limit: number, maxChars = 1500, owner?: string) {
  const revision = sdk.database.query<{ id: number }, [string, string]>(
    "SELECT id FROM graph_source_revisions WHERE source_id=? AND hash=?",
  ).get(sourceId, hash);
  if (!revision) throw new Error(`Missing source-linker revision for ${sourceId}`);
  const stored = sdk.database.query<Pick<HydratedChunk, "chunk_index" | "chunk_type" | "text_content">, [number, number]>(`
    SELECT chunk_index, chunk_type, text_content FROM graph_revision_chunks
    WHERE revision_id=? ORDER BY chunk_index ASC LIMIT ?
  `).all(revision.id, limit);
  const summary = stored.find(chunk => chunk.chunk_index === 0);
  const snippets = stored.filter(chunk => chunk.chunk_index !== 0).sort((a, b) =>
    Number(a.chunk_type !== "verbatim") - Number(b.chunk_type !== "verbatim") || a.chunk_index - b.chunk_index);
  const selected: typeof stored = [];
  let remaining = maxChars;
  if (summary && remaining > 0) {
    const text_content = summary.text_content.slice(0, Math.min(600, Math.floor(maxChars / 3), remaining));
    if (text_content) selected.push({ ...summary, text_content });
    remaining -= text_content.length;
  }
  for (const chunk of snippets) {
    if (remaining <= 2) break;
    if (selected.length) remaining -= 2;
    const text_content = chunk.text_content.slice(0, remaining);
    if (!text_content) break;
    selected.push({ ...chunk, text_content });
    remaining -= text_content.length;
  }
  if (owner && selected.length) {
    const ids = selected.map(chunk => sdk.database.query<{ id: number }, [number, number]>(`SELECT p.id
      FROM graph_revision_passages p WHERE p.revision_id=? AND p.chunk_index=?`).get(revision.id, chunk.chunk_index)?.id)
      .filter((id): id is number => id !== undefined);
    const pin = sdk.database.query(`INSERT INTO source_memory_pins(owner,passage_id,expires_at) VALUES(?,?,?)
      ON CONFLICT(owner,passage_id) DO UPDATE SET expires_at=excluded.expires_at`);
    for (const id of ids) pin.run(owner, id, Date.now() + 24 * 60 * 60 * 1000);
  }
  return { chunks: selected, combinedText: selected.map(chunk => chunk.text_content).join("\n\n") };
}
