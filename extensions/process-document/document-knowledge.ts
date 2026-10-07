import type { ProcessFileResponse } from "../../lib/messages.types";
import type { PreparedSourceClaim } from "../../sdk/graph/prepared";

/** Preserve the model and page when generated transcriptions enter any connector. */
export function documentKnowledge(chunks: ProcessFileResponse["chunks"]): PreparedSourceClaim[] {
  return chunks.flatMap(chunk => {
    if (chunk.metadata?.origin !== "vision-transcription") return [];
    const { model, pageNumber } = chunk.metadata;
    if (typeof model !== "string" || !model.trim() || !Number.isSafeInteger(pageNumber) || Number(pageNumber) < 1)
      throw new Error("Vision transcription requires its model and original page number");
    return [{ predicate: "VISION_TRANSCRIPTION", value: { text: chunk.text_content, pageNumber: Number(pageNumber) },
      chunkIndex: chunk.chunk_index, status: "proposed", method: "vision", model }];
  });
}
