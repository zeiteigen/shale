import type { AIClientOptions, LLMOptions } from "./types";

/** Undefined leaves a profile default intact; null explicitly disables a setting. */
export function mergeOptions<T extends AIClientOptions>(
  defaults?: T,
  overrides?: T,
): T {
  const merged = {
    ...defaults,
    ...Object.fromEntries(
      Object.entries(overrides ?? {}).filter(
        ([, value]) => value !== undefined,
      ),
    ),
  } as T;
  if (overrides?.baseUrl !== undefined) {
    if (overrides.endpoint === undefined) delete merged.endpoint;
    if (overrides.batchEndpoint === undefined) delete merged.batchEndpoint;
  }
  if (overrides?.client !== undefined) {
    for (const key of [
      "endpoint",
      "batchEndpoint",
      "baseUrl",
      "apiKey",
      "fetchFn",
      "timeoutMs",
      "maxRetries",
    ] as const) {
      if (overrides[key] === undefined) delete merged[key];
    }
  }
  return merged;
}

export function normalizeChatOptions(options: LLMOptions = {}): LLMOptions {
  const {
    reasoning_effort,
    max_thinking_tokens,
    thinkingBudget,
    thinking_budget,
    ...rest
  } = options;
  return {
    ...rest,
    reasoningEffort:
      options.reasoningEffort !== undefined
        ? options.reasoningEffort
        : reasoning_effort,
    maxThinkingTokens:
      options.maxThinkingTokens !== undefined
        ? options.maxThinkingTokens
        : max_thinking_tokens !== undefined
          ? max_thinking_tokens
          : thinkingBudget !== undefined
            ? thinkingBudget
            : thinking_budget,
  };
}
