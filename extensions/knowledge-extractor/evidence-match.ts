import type { ExtractionChunk } from './types';

/** Locate exact wording, allowing PDF line-break whitespace; retain the original bytes. */
export function matchEvidence(chunks: ExtractionChunk[], chunkIndex: number, quote: string) {
  if (!quote.trim()) throw new Error('Empty extraction evidence');
  const pattern = quote.trim().split(/\s+/).map(word=>word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s+');
  const locate = (chunk: ExtractionChunk) => {
    const exact = chunk.text_content.indexOf(quote);
    const match = exact < 0 ? new RegExp(pattern).exec(chunk.text_content) : null;
    const start = exact >= 0 ? exact : match?.index;
    return start === undefined ? null : {chunk,start,quote:exact>=0 ? quote : match![0]};
  };
  const declared = chunks.find(chunk=>chunk.chunk_index===chunkIndex);
  const match = declared && locate(declared);
  if (match) return match;
  const alternatives = chunks.map(locate).filter(item=>item!==null);
  if (alternatives.length===1) return alternatives[0]!;
  if (alternatives.length>1) throw new Error('Extraction evidence location is ambiguous; cite the correct chunk');
  throw new Error(`Extraction evidence is absent from supplied chunk ${chunkIndex}: ${JSON.stringify(quote.slice(0,160))}`);
}
