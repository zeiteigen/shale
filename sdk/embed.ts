import OpenAI from "openai";
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

export class EmbedderClient {
  private readonly defaultOptions?: EmbedderOptions;
  private _client?: OpenAI;

  constructor(defaultOptions?: EmbedderOptions | OpenAI) {
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
   * Generates an embedding vector for a single text.
   */
  async embed(text: string, options?: EmbedderOptions): Promise<number[]> {
    return getEmbedding(text, this.mergeOptions(options));
  }

  /**
   * Generates embedding vectors for an array of texts.
   */
  async embedBatch(
    texts: string[],
    options?: EmbedderOptions,
  ): Promise<number[][]> {
    return getEmbeddings(texts, this.mergeOptions(options));
  }

  private mergeOptions(options?: EmbedderOptions): EmbedderOptions {
    if (!options && !this.defaultOptions) {
      return { client: this.client };
    }
    const merged: EmbedderOptions = { ...this.defaultOptions, ...options };
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
