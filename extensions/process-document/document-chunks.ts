import type { ExtractedDocument } from "./extraction.types";

/** Join adjacent fragments only when their location and provenance metadata agree. */
export function packDocumentChunks(chunks: ExtractedDocument["chunks"], maximum: number): ExtractedDocument["chunks"] {
  const packed: ExtractedDocument["chunks"] = [];
  let previousSignature = "";
  for (const chunk of chunks) {
    const signature = JSON.stringify(Object.entries(chunk.metadata).sort(([a], [b]) => a.localeCompare(b)));
    const previous = packed.at(-1);
    if (previous && previousSignature === signature && previous.text.length + chunk.text.length + 2 <= maximum)
      previous.text += `\n\n${chunk.text}`;
    else packed.push({ text: chunk.text, metadata: { ...chunk.metadata } });
    previousSignature = signature;
  }
  return packed;
}
