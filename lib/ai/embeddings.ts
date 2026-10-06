import type OpenAI from "openai";
import type { EmbedderOptions } from "./types";
import { createOpenAIClient } from "./client";
import { resolveEmbeddingEndpoint, resolveTimeout, resolveModelResource } from "./config";
import { resolveConcurrency, resolveEmbeddingBatchSize, resolveEmbeddingBatchChars, resolveBatchMode, resolveBatchEndpoint } from "./batch-config";
import { embeddingGroups } from "./embedding-groups";
import { collectBatchRequests, dispatchBatchRequest } from "./batch-dispatch";
import { boundedMap } from "./bounded-map";
import { modelCoordinator } from "./scheduler";
import { embeddingProfile } from "../embedding-profile";
import { limitModelRequest } from "./request-limit";
import { getRootSetting } from "../settings";
import { modelRequest } from "./request";
import { validateEmbeddings } from "./embedding-response";
import { tagEmbedding } from "../embedding-profile";
import { embeddingStorageDimensions } from "../embedding-storage";

/**
 * Fetches embeddings for one or multiple texts from an OpenAI-compatible API endpoint using the OpenAI SDK.
 */
export async function fetchOpenAIEmbeddings(
  input: string | string[],
  options?: EmbedderOptions,
): Promise<number[][]> {
  const items = Array.isArray(input) ? input : [input];
  if (!items.length) return [];
  const size = resolveEmbeddingBatchSize(options?.batchSize);
  const batchAPI = resolveBatchMode("embedding", options) === "api";
  if (batchAPI && size > 50_000) throw new Error("Embedding batch size cannot exceed 50,000 inputs in API mode");
  const concurrency = batchAPI ? Math.max(1, Math.floor(50_000 / size)) : resolveConcurrency("embedding", options?.concurrency);
  const endpoint = batchAPI
    ? resolveBatchEndpoint("embedding", options) : resolveEmbeddingEndpoint(options);
  // Pin the resolved endpoint for every request in this batch.
  const resolved = { ...options, ...(batchAPI ? { batchEndpoint: endpoint } : { endpoint }) };
  // Async Batch API inputs run separately; its groups are submission limits.
  const groups = embeddingGroups(items, size,
    batchAPI ? Infinity : resolveEmbeddingBatchChars(options?.batchMaxChars), options?.instruction);
  return modelCoordinator.exclusive(resolveModelResource(endpoint, options?.resource), () =>
    modelCoordinator.phase("embedding", async () => {
      const vectors = (await collectBatchRequests(() => boundedMap(groups, concurrency, group => {
        options?.signal?.throwIfAborted();
        return fetchEmbeddingRequest(group, resolved);
      }))).flat();
      const dimensions = embeddingProfile(vectors[0])!.dimensions;
      if (vectors.some(vector => embeddingProfile(vector)!.dimensions !== dimensions))
        throw new Error("Embedding batches returned inconsistent native dimensions");
      return vectors;
    }),
  );
}

async function fetchEmbeddingRequest(
  input: string | string[],
  options?: EmbedderOptions,
): Promise<number[][]> {
  const items = Array.isArray(input) ? input : [input];
  if (items.length === 0) {
    return [];
  }

  const batchAPI = resolveBatchMode("embedding", options) === "api";
  const endpoint = batchAPI ? resolveBatchEndpoint("embedding", options) : resolveEmbeddingEndpoint(options);
  const transportOptions = { ...options, endpoint };
  const client = createOpenAIClient(transportOptions, "embedding");
  const model =
    options?.model ??
    getRootSetting("OPENAI_EMBEDDING_MODEL") ??
    "text-embedding-3-small";

  const padTarget =
    options?.padToDimensions !== undefined
      ? options.padToDimensions
      : embeddingStorageDimensions();

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
    timeout: resolveTimeout(transportOptions, "embedding"),
    signal: options?.signal,
  };

  const response = await modelRequest(
    "embedding",
    endpoint,
    () => batchAPI
      ? dispatchBatchRequest<OpenAI.CreateEmbeddingResponse>("embedding", body, options)
      : limitModelRequest(`embedding:${endpoint}`, resolveConcurrency("embedding", options?.concurrency),
        () => { options?.signal?.throwIfAborted(); return client.embeddings.create(body, requestOptions); }),
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
    // Preserve provenance when switching transport on the same model server.
    endpoint: batchAPI ? endpoint.replace(/\/batches(?=\?|$)/, "/embeddings") : endpoint,
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
