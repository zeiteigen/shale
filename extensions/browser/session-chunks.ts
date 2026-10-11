import type { ShaleSDK } from "@shale/sdk";
import type { SourceGraph } from "../../sdk/graph/source";

/** Keep the complete narrative and observation JSON within model input limits. */
export function sessionChunks(narrative: string, observation: string, size = 1000) {
  if (!Number.isSafeInteger(size) || size < 1 || size > 4000) throw new Error("Invalid session chunk size");
  const split = (text: string, chunk_type: "synthetic" | "verbatim") => {
    const chunks: { text_content: string; chunk_type: typeof chunk_type }[] = [];
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + size, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end++;
      chunks.push({ text_content: text.slice(start, end), chunk_type });
      start = end;
    }
    return chunks;
  };
  // Session observations remain in the typed activity tables. Never duplicate
  // their complete event JSON into searchable source chunks.
  void observation;
  return split(narrative, "synthetic").map((chunk, chunk_index) => ({
    ...chunk,
    chunk_index,
  }));
}

/** A split observation is grounded in its complete immutable source revision. */
export function sessionEvidence(sdk: ShaleSDK, sourceId: string, graph: SourceGraph) {
  const chunks = sdk.database.query<{chunk_index: number; chunk_type: string}, [string]>(
    "SELECT chunk_index,chunk_type FROM chunks WHERE source_id=? ORDER BY chunk_index").all(sourceId);
  const observed = chunks.filter(chunk => chunk.chunk_type === "verbatim");
  return {
    observed: graph.evidence(observed.length === 1 ? observed[0].chunk_index : undefined),
    generated: chunks.filter(chunk => chunk.chunk_type === "synthetic")
      .flatMap(chunk => graph.evidence(chunk.chunk_index, undefined, "generated", "mentions")),
  };
}
