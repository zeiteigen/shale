import { fetchOpenAIChatCompletion } from "./chat";
import { boundedMap } from "./bounded-map";
import { mapWithBatchProgress } from "./batch-progress";
import { resolveChatBatchWidth, resolveBatchEndpoint, resolveBatchMode } from "./batch-config";
import { collectBatchRequests } from "./batch-dispatch";
import { resolveChatEndpoint, resolveModelResource } from "./config";
import { modelCoordinator } from "./scheduler";
import type { LLMOptions, LLMQueryInput, LLMResponse } from "./types";

/** Chat batches use bounded concurrent OpenAI-compatible completion requests. */
export function fetchOpenAIChatCompletions(
  inputs: readonly (string | LLMQueryInput)[], options?: LLMOptions,
): Promise<LLMResponse[]> {
  if (!inputs.length) return Promise.resolve([]);
  const batchAPI = resolveBatchMode("chat", options) === "api";
  const endpoint = batchAPI
    ? resolveBatchEndpoint("chat", options) : resolveChatEndpoint(options);
  const concurrency = resolveChatBatchWidth(options);
  return modelCoordinator.exclusive(resolveModelResource(endpoint, options?.resource), () =>
    collectBatchRequests(() => {
      const work = (input: string | LLMQueryInput) => {
        options?.signal?.throwIfAborted();
        return fetchOpenAIChatCompletion(input, options);
      };
      return batchAPI ? boundedMap(inputs, concurrency, work)
        : mapWithBatchProgress("chat", inputs, concurrency, work);
    }),
  );
}
