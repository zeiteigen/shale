import OpenAI from "openai";
import { mergeOptions, normalizeChatOptions } from "../lib/ai/options";
import { resolveModelId } from "../lib/ai/config";
import {
  createOpenAIClient,
  queryLLM as coreQueryLLM,
  fetchOpenAIChatCompletion,
  fetchOpenAIChatCompletions,
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
    const options = mergeOptions(this.defaultOptions, normalizeChatOptions(overrides));
    return { ...options, model: resolveModelId("chat", options) };
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

  completeBatch(inputs: readonly (string | LLMQueryInput)[], options?: LLMOptions): Promise<LLMResponse[]> {
    return fetchOpenAIChatCompletions(inputs, this.options(options));
  }

  async queryBatch(inputs: readonly (string | LLMQueryInput)[], options: LLMOptions & { detailed: true }): Promise<LLMResponse[]>;
  async queryBatch(inputs: readonly (string | LLMQueryInput)[], options?: LLMOptions): Promise<string[]>;
  async queryBatch(inputs: readonly (string | LLMQueryInput)[], options?: LLMOptions): Promise<string[] | LLMResponse[]> {
    const results = await this.completeBatch(inputs, options);
    return this.options(options).detailed ? results : results.map(result => result.content);
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
  fetchOpenAIChatCompletions,
};

export default LLMClient;
