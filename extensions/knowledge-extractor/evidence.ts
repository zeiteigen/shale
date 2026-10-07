import type { EvidenceInput } from '@shale/sdk';
import type { ExtractionCheckpoint, ExtractedClaim } from './types';
import { matchEvidence } from './evidence-match';

export function groundEvidence(checkpoint: ExtractionCheckpoint, items: ExtractedClaim['evidence']): EvidenceInput[] {
  if (!items.length) throw new Error('Every extracted claim and event requires source evidence');
  return items.map(item=> {
    const match=matchEvidence(checkpoint.chunks,item.chunkIndex,item.quote);
    const start = match.start + (match.chunk.start ?? 0);
    return {revisionId:checkpoint.revisionId,sourceId:checkpoint.sourceId,chunkIndex:match.chunk.chunk_index,
      quote:match.quote,locator:{start,end:start+match.quote.length},method:'llm',model:checkpoint.model};
  });
}
