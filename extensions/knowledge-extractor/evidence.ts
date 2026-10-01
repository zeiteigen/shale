import type { EvidenceInput } from '@shale/sdk';
import type { ExtractionCheckpoint, ExtractedClaim } from './types';

export function groundEvidence(checkpoint: ExtractionCheckpoint, items: ExtractedClaim['evidence']): EvidenceInput[] {
  if (!items.length) throw new Error('Every extracted claim and event requires source evidence');
  return items.map(item=> {
    const chunk=checkpoint.chunks.find(c=>c.chunk_index===item.chunkIndex);
    const start=chunk?.text_content.indexOf(item.quote) ?? -1;
    if (!item.quote || start<0) throw new Error('Extraction evidence is absent from the supplied text');
    return {revisionId:checkpoint.revisionId,sourceId:checkpoint.sourceId,chunkIndex:item.chunkIndex,
      quote:item.quote,locator:{start,end:start+item.quote.length},method:'llm',model:checkpoint.model};
  });
}

