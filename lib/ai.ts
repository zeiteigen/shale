// Compatibility entry point. Implementations live in atomic modules under ./ai.
export * from "./ai/types";
export * from "./ai/config";
export * from "./ai/client";
export * from "./ai/chat";
export * from "./ai/embeddings";
export * from "./ai/images";
export { normalizeVectorDimensions } from "./embedding-index";

import {
  getEmbedding,
  getEmbeddings,
  fetchOpenAIEmbeddings,
} from "./ai/embeddings";
import { queryLLM, fetchOpenAIChatCompletion } from "./ai/chat";
import {
  resolveEmbeddingEndpoint,
  resolveChatEndpoint,
  isLocalEndpoint,
  resolveTimeout,
} from "./ai/config";
import { createOpenAIClient } from "./ai/client";
import { normalizeImageContentPart } from "./ai/images";
import { normalizeVectorDimensions } from "./embedding-index";
export default {
  getEmbedding,
  getEmbeddings,
  fetchOpenAIEmbeddings,
  queryLLM,
  fetchOpenAIChatCompletion,
  resolveEmbeddingEndpoint,
  resolveChatEndpoint,
  isLocalEndpoint,
  resolveTimeout,
  createOpenAIClient,
  normalizeImageContentPart,
  normalizeVectorDimensions,
};
