import OpenAI from "openai";
import { mergeOptions } from "../lib/ai/options";
import {
  getEmbedding,
  getEmbeddings,
  resolveEmbeddingEndpoint,
  normalizeVectorDimensions,
  createOpenAIClient,
  fetchOpenAIEmbeddings,
  type EmbedderOptions,
  type OpenAIEmbeddingResponse,
} from "../lib/ai";

export interface EmbeddingClient {
  embed(text: string, options?: EmbedderOptions): Promise<number[]>;
  embedBatch(texts: string[], options?: EmbedderOptions): Promise<number[][]>;
}

/** Compatibility wrapper; configuration is resolved fresh for every request. */
export class EmbedderClient implements EmbeddingClient {
  private readonly defaultOptions: EmbedderOptions;

  constructor(options?: EmbedderOptions | OpenAI) {
    this.defaultOptions =
      options instanceof OpenAI ? { client: options } : (options ?? {});
  }

  get client(): OpenAI {
    return createOpenAIClient(this.defaultOptions, "embedding");
  }

  options(overrides?: EmbedderOptions): EmbedderOptions {
    return mergeOptions(this.defaultOptions, overrides);
  }

  embed(text: string, options?: EmbedderOptions): Promise<number[]> {
    return getEmbedding(text, this.options(options));
  }

  embedBatch(texts: string[], options?: EmbedderOptions): Promise<number[][]> {
    return getEmbeddings(texts, this.options(options));
  }
}

/**
 * High-level embedding function supporting single string or string array.
 */
export async function embed(
  input: string,
  options?: EmbedderOptions,
): Promise<number[]>;
export async function embed(
  input: string[],
  options?: EmbedderOptions,
): Promise<number[][]>;
export async function embed(
  input: string | string[],
  options?: EmbedderOptions,
): Promise<number[] | number[][]> {
  if (Array.isArray(input)) {
    return getEmbeddings(input, options);
  }
  return getEmbedding(input, options);
}

export {
  getEmbedding,
  getEmbeddings,
  resolveEmbeddingEndpoint,
  normalizeVectorDimensions,
  createOpenAIClient,
  fetchOpenAIEmbeddings,
  type EmbedderOptions,
  type OpenAIEmbeddingResponse,
};

export default EmbedderClient;
