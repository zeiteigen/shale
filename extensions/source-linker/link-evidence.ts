import type { EvidenceInput, HydratedChunk, ShaleSDK } from "@shale/sdk";

/** Record exactly the prefixes passed to the chat model, before any async work. */
export function linkEvidence(sdk: ShaleSDK, sourceId: string, hash: string, chunks: Pick<HydratedChunk, "chunk_index" | "chunk_type" | "text_content">[], maxChars: number): EvidenceInput[] {
  const revision = sdk.database.query<{id:number}, [string,string]>(
    'SELECT id FROM graph_source_revisions WHERE source_id=? AND hash=?').get(sourceId,hash);
  if (!revision) return [];
  const evidence: EvidenceInput[] = [];
  let remaining = maxChars;
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]!;
    const text = chunk.text_content.slice(0, Math.max(0, remaining));
    // Summaries and generated descriptions are useful context, but cannot be cited as observed text.
    if (chunk.chunk_type === "verbatim" && text) evidence.push({revisionId:revision.id,sourceId,chunkIndex:chunk.chunk_index,
      quote:text,locator:{start:0,end:text.length},method:'llm-context'});
    remaining -= text.length;
    if (index < chunks.length - 1) remaining -= 2;
    if (remaining <= 0) break;
  }
  return evidence;
}
