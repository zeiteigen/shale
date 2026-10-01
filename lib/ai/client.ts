import OpenAI from "openai";
import type { ClientOptions } from "openai";
import type { AIClientOptions } from "./types";
import {
  resolveApiKey,
  resolveRetries,
  resolveTimeout,
  type ModelRole,
} from "./config";

/** Clients are inexpensive request configuration objects, not loaded models. */
export function createOpenAIClient(
  options?: AIClientOptions,
  role: ModelRole = "chat",
): OpenAI {
  if (options?.client) {
    const overrides: Partial<ClientOptions> = {};
    if (options.apiKey !== undefined) overrides.apiKey = resolveApiKey(options, role);
    if (options.baseUrl !== undefined) overrides.baseURL = options.baseUrl;
    if (options.fetchFn !== undefined) overrides.fetch = options.fetchFn;
    if (options.timeoutMs !== undefined) overrides.timeout = options.timeoutMs;
    if (options.maxRetries !== undefined)
      overrides.maxRetries = options.maxRetries;
    return Object.keys(overrides).length
      ? options.client.withOptions(overrides)
      : options.client;
  }
  return new OpenAI({
    apiKey: resolveApiKey(options, role),
    baseURL: options?.baseUrl,
    fetch: options?.fetchFn,
    timeout: resolveTimeout(options, role),
    maxRetries: resolveRetries(options, role),
  });
}
