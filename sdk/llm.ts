import OpenAI from "openai";
import {
  createOpenAIClient,
  queryLLM as coreQueryLLM,
  fetchOpenAIChatCompletion,
  resolveChatEndpoint,
  normalizeImageContentPart,
  type LLMOptions,
  type LLMResponse,
  type LLMImageInput,
  type LLMImageObject,
  type LLMImageDetail,
  type LLMQueryInput,
  type AIClientOptions,
  type LLMReasoningEffort,
} from "../lib/ai";

export class LLMClient {
  private readonly defaultOptions?: LLMOptions;
  private _client?: OpenAI;

  constructor(defaultOptions?: LLMOptions | OpenAI) {
    if (defaultOptions instanceof OpenAI) {
      this.defaultOptions = {
        client: defaultOptions,
        reasoning_effort: "low",
        max_thinking_tokens: 512,
      };
      this._client = defaultOptions;
    } else {
      this.defaultOptions = {
        reasoning_effort: "low",
        max_thinking_tokens: 512,
        ...defaultOptions,
      };
      if (defaultOptions?.client) {
        this._client = defaultOptions.client;
      }
    }
  }

  /**
   * Access the underlying OpenAI SDK client.
   */
  get client(): OpenAI {
    if (!this._client) {
      this._client = createOpenAIClient(this.defaultOptions);
    }
    return this._client;
  }

  /**
   * Queries the LLM with text prompt and optional images.
   */
  async query(
    input: string | LLMQueryInput,
    options: LLMOptions & { detailed: true },
  ): Promise<LLMResponse>;
  async query(
    input: string | LLMQueryInput,
    options?: LLMOptions,
  ): Promise<string>;
  async query(
    input: string | LLMQueryInput,
    options?: LLMOptions & { detailed?: boolean },
  ): Promise<string | LLMResponse> {
    const merged = this.mergeOptions(options);
    return coreQueryLLM(input, merged as any);
  }

  /**
   * Queries the LLM and returns the full structured completion response.
   */
  async complete(
    input: string | LLMQueryInput,
    options?: LLMOptions,
  ): Promise<LLMResponse> {
    const merged = this.mergeOptions(options);
    return fetchOpenAIChatCompletion(input, merged);
  }

  private mergeOptions(options?: LLMOptions): LLMOptions {
    const base: LLMOptions = {
      reasoning_effort: "low",
      max_thinking_tokens: 512,
      ...this.defaultOptions,
    };
    if (!options) {
      if (!base.client) {
        base.client = this.client;
      }
      return base;
    }
    const merged: LLMOptions = { ...base, ...options };
    if (
      options.reasoningEffort !== undefined &&
      options.reasoning_effort === undefined
    ) {
      merged.reasoning_effort = options.reasoningEffort;
    }
    if (
      options.maxThinkingTokens !== undefined &&
      options.max_thinking_tokens === undefined
    ) {
      merged.max_thinking_tokens = options.maxThinkingTokens;
    }
    if (
      options.thinkingBudget !== undefined &&
      options.max_thinking_tokens === undefined
    ) {
      merged.max_thinking_tokens = options.thinkingBudget;
    }
    if (
      options.thinking_budget !== undefined &&
      options.max_thinking_tokens === undefined
    ) {
      merged.max_thinking_tokens = options.thinking_budget;
    }
    if (!merged.client) {
      const hasClientOverrides = Boolean(
        options &&
        (options.apiKey !== undefined ||
          options.baseUrl !== undefined ||
          options.endpoint !== undefined ||
          options.fetchFn !== undefined ||
          options.timeoutMs !== undefined ||
          options.maxRetries !== undefined),
      );
      merged.client = hasClientOverrides ? undefined : this.client;
    }
    return merged;
  }
}

/**
 * Top-level queryLLM function.
 */
export async function queryLLM(
  input: string | LLMQueryInput,
  options: LLMOptions & { detailed: true },
): Promise<LLMResponse>;
export async function queryLLM(
  input: string | LLMQueryInput,
  options?: LLMOptions,
): Promise<string>;
export async function queryLLM(
  input: string | LLMQueryInput,
  options?: LLMOptions & { detailed?: boolean },
): Promise<string | LLMResponse> {
  return coreQueryLLM(input, options as any);
}

export {
  type LLMOptions,
  type LLMResponse,
  type LLMImageInput,
  type LLMImageObject,
  type LLMImageDetail,
  type LLMQueryInput,
  type AIClientOptions,
  type LLMReasoningEffort,
  resolveChatEndpoint,
  normalizeImageContentPart,
  fetchOpenAIChatCompletion,
};

export default LLMClient;
