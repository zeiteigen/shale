import type { EvidenceInput, HydratedChunk, ShaleSDK } from "@shale/sdk";

/** Record exactly the prefixes passed to the chat model, before any async work. */
export function linkEvidence(sdk: ShaleSDK, sourceId: string, hash: string, chunks: HydratedChunk[], maxChars: number): EvidenceInput[] {
  const revision = sdk.database.query<{id:number}, [string,string]>(
    'SELECT id FROM graph_source_revisions WHERE source_id=? AND hash=?').get(sourceId,hash);
  if (!revision) return [];
  let remaining = maxChars;
  const evidence: EvidenceInput[] = [];
  for (const chunk of chunks) {
    const quote = chunk.text_content.slice(0,Math.max(0,remaining));
    if (quote) evidence.push({revisionId:revision.id,sourceId,chunkIndex:chunk.chunk_index,
      quote,locator:{start:0,end:quote.length},method:'llm-context'});
    remaining -= chunk.text_content.length + 2;
    if (remaining <= 0) break;
  }
  return evidence;
}
