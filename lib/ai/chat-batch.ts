import { fetchOpenAIChatCompletion } from "./chat";
import { boundedMap } from "./bounded-map";
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
  const endpoint = resolveBatchMode("chat", options) === "api"
    ? resolveBatchEndpoint("chat", options) : resolveChatEndpoint(options);
  const concurrency = resolveChatBatchWidth(options);
  return modelCoordinator.exclusive(resolveModelResource(endpoint, options?.resource), () =>
    modelCoordinator.phase("chat", () => collectBatchRequests(() => boundedMap(inputs, concurrency, input => {
      options?.signal?.throwIfAborted();
      return fetchOpenAIChatCompletion(input, options);
    }))),
  );
}
