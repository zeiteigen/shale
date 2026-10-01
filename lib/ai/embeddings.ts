import type OpenAI from "openai";
import type { EmbedderOptions } from "./types";
import { createOpenAIClient } from "./client";
import { resolveEmbeddingEndpoint, resolveTimeout } from "./config";
import { modelRequest } from "./request";
import { validateEmbeddings } from "./embedding-response";
import { tagEmbedding } from "../embedding-profile";

/**
 * Fetches embeddings for one or multiple texts from an OpenAI-compatible API endpoint using the OpenAI SDK.
 */
export async function fetchOpenAIEmbeddings(
  input: string | string[],
  options?: EmbedderOptions,
): Promise<number[][]> {
  const items = Array.isArray(input) ? input : [input];
  if (items.length === 0) {
    return [];
  }

  const client = createOpenAIClient(options, "embedding");
  const endpoint = resolveEmbeddingEndpoint(options);
  const model =
    options?.model ??
    process.env.OPENAI_EMBEDDING_MODEL ??
    process.env.EMBEDDING_MODEL ??
    "text-embedding-3-small";

  const padTarget =
    options?.padToDimensions !== undefined
      ? options.padToDimensions
      : process.env.EMBEDDING_DIMENSIONS
        ? Number(process.env.EMBEDDING_DIMENSIONS)
        : 4096;

  if (
    options?.dimensions !== undefined &&
    (!Number.isInteger(options.dimensions) || options.dimensions <= 0)
  ) {
    throw new Error("Embedding dimensions must be a positive integer");
  }
  if (padTarget !== null && (!Number.isInteger(padTarget) || padTarget <= 0)) {
    throw new Error("Embedding storage dimensions must be a positive integer");
  }

  const processedItems = options?.instruction
    ? items.map((text) => `Instruct: ${options.instruction}\nQuery: ${text}`)
    : items;

  const body: OpenAI.EmbeddingCreateParams = {
    input: processedItems,
    model,
  };

  if (options?.dimensions) {
    body.dimensions = options.dimensions;
  }

  const requestOptions: any = {
    path: endpoint,
    timeout: resolveTimeout(options, "embedding"),
    signal: options?.signal,
  };

  const response = await modelRequest(
    "embedding",
    endpoint,
    () => client.embeddings.create(body, requestOptions),
    options?.resource,
  );
  const vectors = validateEmbeddings(response, items.length, padTarget);
  if (
    options?.dimensions !== undefined &&
    response.data[0].embedding.length !== options.dimensions
  ) {
    throw new Error(
      "Embedding endpoint returned a different dimension than requested",
    );
  }
  const profile = {
    model,
    endpoint,
    dimensions: response.data[0].embedding.length,
    storageDimensions: vectors[0].length,
    instruction: options?.instruction ?? null,
  };
  return vectors.map((vector) => tagEmbedding(vector, profile));
}

/**
 * Computes embedding for a single string.
 */
export async function getEmbedding(
  text: string,
  options?: EmbedderOptions,
): Promise<number[]> {
  const results = await fetchOpenAIEmbeddings(text, options);
  if (results.length === 0) {
    throw new Error("No embedding returned for text.");
  }
  return results[0];
}

/**
 * Computes embeddings for multiple strings in batch.
 */
export async function getEmbeddings(
  texts: string[],
  options?: EmbedderOptions,
): Promise<number[][]> {
  return fetchOpenAIEmbeddings(texts, options);
}
