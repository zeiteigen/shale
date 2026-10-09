// Compatibility entry point. Implementations live in atomic modules under ./ai.
export * from "./ai/types";
export * from "./ai/config";
export * from "./ai/client";
export * from "./ai/chat";
export * from "./ai/chat-batch";
export * from "./ai/images";

import { queryLLM, fetchOpenAIChatCompletion } from "./ai/chat";
import { fetchOpenAIChatCompletions } from "./ai/chat-batch";
import {
  resolveChatEndpoint,
  isLocalEndpoint,
  resolveTimeout,
} from "./ai/config";
import { createOpenAIClient } from "./ai/client";
import { normalizeImageContentPart } from "./ai/images";
export default {
  queryLLM,
  fetchOpenAIChatCompletion,
  fetchOpenAIChatCompletions,
  resolveChatEndpoint,
  isLocalEndpoint,
  resolveTimeout,
  createOpenAIClient,
  normalizeImageContentPart,
};
