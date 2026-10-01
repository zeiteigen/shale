import OpenAI from "openai";
import { mergeOptions, normalizeChatOptions } from "../lib/ai/options";
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

/** Compatibility wrapper; all defaults and aliases have one owner. */
export class LLMClient {
  private readonly defaultOptions: LLMOptions;

  constructor(options?: LLMOptions | OpenAI) {
    this.defaultOptions = normalizeChatOptions(
      options instanceof OpenAI ? { client: options } : options,
    );
  }

  get client(): OpenAI {
    return createOpenAIClient(this.defaultOptions, "chat");
  }

  options(overrides?: LLMOptions): LLMOptions {
    return mergeOptions(this.defaultOptions, normalizeChatOptions(overrides));
  }

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
    options?: LLMOptions,
  ): Promise<string | LLMResponse> {
    const merged = this.options(options);
    const response = await this.complete(input, options);
    return merged.detailed ? response : response.content;
  }

  complete(
    input: string | LLMQueryInput,
    options?: LLMOptions,
  ): Promise<LLMResponse> {
    return fetchOpenAIChatCompletion(input, this.options(options));
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
