import type OpenAI from "openai";
import { normalizeVectorDimensions, validateVector } from "../embedding-index";

export function validateEmbeddings(
  response: OpenAI.CreateEmbeddingResponse,
  count: number,
  target?: number | null,
): number[][] {
  if (!Array.isArray(response?.data) || response.data.length !== count) {
    throw new Error(`Embedding response must contain exactly ${count} vectors`);
  }
  const sorted = [...response.data].sort((a, b) => a.index - b.index);
  const dimension = sorted[0]?.embedding?.length;
  return sorted.map((item, index) => {
    if (item.index !== index)
      throw new Error("Embedding response has missing or duplicate indices");
    validateVector(item.embedding, dimension);
    return target == null
      ? item.embedding
      : normalizeVectorDimensions(item.embedding, target);
  });
}
