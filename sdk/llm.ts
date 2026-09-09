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
} from "../lib/ai";

export class LLMClient {
  private readonly defaultOptions?: LLMOptions;
  private _client?: OpenAI;

  constructor(defaultOptions?: LLMOptions | OpenAI) {
    if (defaultOptions instanceof OpenAI) {
      this.defaultOptions = { client: defaultOptions };
      this._client = defaultOptions;
    } else {
      this.defaultOptions = defaultOptions;
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
    if (!options && !this.defaultOptions) {
      return { client: this.client };
    }
    const merged: LLMOptions = { ...this.defaultOptions, ...options };
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
  resolveChatEndpoint,
  normalizeImageContentPart,
  fetchOpenAIChatCompletion,
};

export default LLMClient;
