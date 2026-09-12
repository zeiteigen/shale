import OpenAI from "openai";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";

export type FetchFn = (
  url: RequestInfo | URL | string,
  init?: RequestInit | any,
) => Promise<Response>;

export interface AIClientOptions {
  apiKey?: string;
  baseUrl?: string;
  endpoint?: string;
  fetchFn?: FetchFn | typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  client?: OpenAI;
}

export interface EmbedderOptions extends AIClientOptions {
  model?: string;
  dimensions?: number;
  padToDimensions?: number | null;
  instruction?: string;
}

export type LLMImageDetail = "auto" | "low" | "high";

export interface LLMImageObject {
  url?: string;
  path?: string;
  data?: string | Uint8Array | Buffer;
  mimeType?: string;
  detail?: LLMImageDetail;
}

export type LLMImageInput = string | LLMImageObject | Uint8Array | Buffer;

export interface LLMQueryInput {
  prompt?: string;
  images?: LLMImageInput | LLMImageInput[];
  system?: string;
  messages?: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam>;
}

export type LLMReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | null;

export interface LLMOptions extends AIClientOptions {
  model?: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  images?: LLMImageInput | LLMImageInput[];
  detailed?: boolean;
  messages?: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam>;
  responseFormat?: OpenAI.Chat.Completions.ChatCompletionCreateParams["response_format"];
  reasoningEffort?: LLMReasoningEffort | string;
  reasoning_effort?: LLMReasoningEffort | string;
  maxThinkingTokens?: number | null;
  max_thinking_tokens?: number | null;
  thinkingBudget?: number | null;
  thinking_budget?: number | null;
}

export interface LLMResponse {
  content: string;
  reasoningContent?: string;
  model: string;
  finishReason?: string | null;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  raw: OpenAI.Chat.Completions.ChatCompletion;
}

export interface OpenAIEmbeddingResponse {
  object?: string;
  data: Array<{
    object?: string;
    index: number;
    embedding: number[];
  }>;
  model?: string;
  usage?: {
    prompt_tokens: number;
    total_tokens: number;
  };
  error?: {
    message: string;
    type?: string;
    code?: string;
  };
}

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
};

/**
 * Normalizes varied image inputs (URL, local path, base64 data URL, Buffer) into an OpenAI ChatCompletionContentPart.
 */
export function normalizeImageContentPart(
  img: LLMImageInput,
): OpenAI.Chat.Completions.ChatCompletionContentPart {
  let url = "";
  let detail: LLMImageDetail | undefined;

  if (typeof img === "string") {
    if (
      img.startsWith("http://") ||
      img.startsWith("https://") ||
      img.startsWith("data:")
    ) {
      url = img;
    } else if (existsSync(img)) {
      const ext = extname(img).toLowerCase();
      const mime = MIME_TYPES[ext] || "image/jpeg";
      const b64 = readFileSync(img).toString("base64");
      url = `data:${mime};base64,${b64}`;
    } else {
      url = `data:image/jpeg;base64,${img}`;
    }
  } else if (img instanceof Uint8Array || Buffer.isBuffer(img)) {
    const b64 = Buffer.from(img).toString("base64");
    url = `data:image/jpeg;base64,${b64}`;
  } else if (typeof img === "object" && img !== null) {
    detail = img.detail;
    if (img.url) {
      if (
        img.url.startsWith("http://") ||
        img.url.startsWith("https://") ||
        img.url.startsWith("data:")
      ) {
        url = img.url;
      } else if (existsSync(img.url)) {
        const ext = extname(img.url).toLowerCase();
        const mime = MIME_TYPES[ext] || "image/jpeg";
        const b64 = readFileSync(img.url).toString("base64");
        url = `data:${mime};base64,${b64}`;
      } else {
        url = `data:image/jpeg;base64,${img.url}`;
      }
    } else if (img.path && existsSync(img.path)) {
      const ext = extname(img.path).toLowerCase();
      const mime = img.mimeType || MIME_TYPES[ext] || "image/jpeg";
      const b64 = readFileSync(img.path).toString("base64");
      url = `data:${mime};base64,${b64}`;
    } else if (img.data) {
      const mime = img.mimeType || "image/jpeg";
      const b64 =
        typeof img.data === "string"
          ? img.data
          : Buffer.from(img.data).toString("base64");
      url = b64.startsWith("data:") ? b64 : `data:${mime};base64,${b64}`;
    }
  }

  if (!url) {
    throw new Error("Invalid image input provided to LLM query.");
  }

  return {
    type: "image_url",
    image_url: detail ? { url, detail } : { url },
  };
}

/**
 * Resolves the full URL for the OpenAI-compatible chat completions endpoint.
 */
export function resolveChatEndpoint(options?: LLMOptions): string {
  const explicit =
    options?.endpoint ??
    process.env.OPENAI_CHAT_ENDPOINT ??
    process.env.OPENAI_ENDPOINT;

  if (explicit) {
    return explicit;
  }

  const rawBase =
    options?.baseUrl ??
    process.env.OPENAI_BASE_URL ??
    "https://api.openai.com/v1";

  const base = rawBase.replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

/**
 * Resolves the full URL for the OpenAI-compatible embeddings endpoint.
 */
export function resolveEmbeddingEndpoint(options?: EmbedderOptions): string {
  const explicit =
    options?.endpoint ??
    process.env.OPENAI_ENDPOINT ??
    process.env.EMBEDDING_ENDPOINT;

  if (explicit) {
    return explicit;
  }

  const rawBase =
    options?.baseUrl ??
    process.env.OPENAI_BASE_URL ??
    process.env.EMBEDDING_BASE_URL ??
    "https://api.openai.com/v1";

  const base = rawBase.replace(/\/+$/, "");
  return base.endsWith("/embeddings") ? base : `${base}/embeddings`;
}

/**
 * Normalizes vector dimensions to target dimension (default: 4096) for sqlite-vec compatibility.
 */
export function normalizeVectorDimensions(
  vector: number[],
  targetDim: number = 4096,
): number[] {
  if (!targetDim || vector.length === targetDim) {
    return vector;
  }

  if (vector.length > targetDim) {
    return vector.slice(0, targetDim);
  }

  const padded = new Float32Array(targetDim);
  padded.set(vector);
  return Array.from(padded);
}

/**
 * Detects whether an endpoint URL points to a local host (e.g. localhost, 127.0.0.1, Ollama, vLLM).
 */
export function isLocalEndpoint(url?: string): boolean {
  if (!url) return false;
  try {
    const raw =
      url.startsWith("http://") || url.startsWith("https://")
        ? url
        : `http://${url}`;
    const parsed = new URL(raw);
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "0.0.0.0" ||
      parsed.hostname === "::1" ||
      parsed.hostname.endsWith(".local") ||
      parsed.hostname === "host.docker.internal"
    );
  } catch {
    return url.includes("localhost") || url.includes("127.0.0.1");
  }
}

/**
 * Resolves the request timeout in milliseconds.
 *
 * Local model servers (vLLM, Ollama, llama.cpp, LocalAI) must cold-load multi-gigabyte
 * model weights from disk to GPU VRAM on the first request, which can take 15-45 seconds.
 * To prevent premature "Request timed out" errors for local users without requiring artificial
 * "warm-up" requests, local endpoints receive an automatic 300,000ms (5-minute) timeout.
 * Cloud APIs (e.g. api.openai.com) default to 60,000ms.
 * Explicit overrides via options or environment variables take highest priority.
 */
export function resolveTimeout(
  options?: AIClientOptions,
  type: "chat" | "embedding" = "chat",
): number {
  if (options?.timeoutMs !== undefined) {
    return options.timeoutMs;
  }

  const envTimeout =
    Number(process.env.MODEL_TIMEOUT_MS) ||
    Number(process.env.OPENAI_TIMEOUT_MS) ||
    (type === "chat"
      ? Number(process.env.CHAT_TIMEOUT_MS) ||
        Number(process.env.OPENAI_CHAT_TIMEOUT_MS)
      : Number(process.env.EMBEDDING_TIMEOUT_MS) ||
        Number(process.env.OPENAI_EMBEDDING_TIMEOUT_MS));

  if (envTimeout && !isNaN(envTimeout) && envTimeout > 0) {
    return envTimeout;
  }

  const rawBase =
    options?.baseUrl ??
    process.env.OPENAI_BASE_URL ??
    (type === "chat"
      ? process.env.OPENAI_CHAT_ENDPOINT
      : process.env.EMBEDDING_BASE_URL);

  if (isLocalEndpoint(rawBase)) {
    return 300000; // 5 minutes for local model loading
  }

  return 60000; // 1 minute default for cloud APIs
}

/**
 * Instantiates an OpenAI SDK client configured with the provided options or environment settings.
 */
export function createOpenAIClient(options?: AIClientOptions): OpenAI {
  if (options?.client) {
    return options.client;
  }

  const apiKey =
    options?.apiKey ||
    process.env.OPENAI_API_KEY ||
    process.env.EMBEDDING_API_KEY ||
    "dummy";

  const fetchImpl = options?.fetchFn ?? fetch;
  const wrappedFetch = async (url: any, init?: any): Promise<Response> => {
    let headers = init?.headers;
    if (headers) {
      headers = new Proxy(headers as any, {
        get(target, prop, receiver) {
          if (
            typeof prop === "string" &&
            typeof target.has === "function" &&
            target.has(prop)
          ) {
            return target.get(prop);
          }
          const val = Reflect.get(target, prop, receiver);
          if (typeof val === "function") {
            return val.bind(target);
          }
          return val;
        },
      });
    }
    return (fetchImpl as any)(url, {
      ...init,
      headers: headers as HeadersInit,
    });
  };

  const rawBase =
    options?.baseUrl ??
    process.env.OPENAI_BASE_URL ??
    process.env.EMBEDDING_BASE_URL;

  const timeout = resolveTimeout(options);
  const maxRetries =
    options?.maxRetries ??
    (Number(process.env.OPENAI_MAX_RETRIES) ||
      (isLocalEndpoint(rawBase) ? 2 : 0));

  return new OpenAI({
    apiKey,
    baseURL: rawBase,
    fetch: wrappedFetch as any,
    timeout,
    maxRetries,
  });
}

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

  const client = options?.client ?? createOpenAIClient(options);
  const endpoint = resolveEmbeddingEndpoint(options);
  const model =
    options?.model ??
    process.env.OPENAI_EMBEDDING_MODEL ??
    process.env.EMBEDDING_MODEL ??
    "text-embedding-3-small";

  const padTarget =
    options?.padToDimensions !== undefined
      ? options.padToDimensions
      : Number(process.env.EMBEDDING_DIMENSIONS) || 4096;

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
  };

  let response: OpenAI.CreateEmbeddingResponse;
  try {
    response = await client.embeddings.create(body, requestOptions);
  } catch (err: any) {
    if (err instanceof OpenAI.APIError) {
      let errorDetail = "";
      if (
        err.error &&
        typeof err.error === "object" &&
        "message" in err.error
      ) {
        errorDetail = String((err.error as any).message);
      } else if (err.message) {
        errorDetail = err.message;
      } else {
        errorDetail = JSON.stringify(err.error ?? "");
      }
      throw new Error(
        `OpenAI Embedding API error (HTTP ${err.status} from ${endpoint}): ${errorDetail}`,
      );
    }
    if (
      err instanceof OpenAI.APIConnectionError ||
      err instanceof OpenAI.APIConnectionTimeoutError
    ) {
      throw new Error(
        `Failed to connect to embedding endpoint at ${endpoint}: ${(err.cause as any)?.message || err.message}`,
      );
    }
    throw err;
  }

  if (!response?.data || !Array.isArray(response.data)) {
    throw new Error(
      "Invalid response structure from embedding endpoint: missing 'data' array.",
    );
  }

  const sorted = [...response.data].sort((a, b) => a.index - b.index);
  return sorted.map((item) => {
    const rawVector: number[] = Array.isArray(item.embedding)
      ? item.embedding
      : Array.from<number>(item.embedding as any);
    return padTarget && padTarget > 0
      ? normalizeVectorDimensions(rawVector, padTarget)
      : rawVector;
  });
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

/**
 * Queries an OpenAI-compatible chat completion model with support for text and images.
 */
export async function fetchOpenAIChatCompletion(
  input: string | LLMQueryInput,
  options?: LLMOptions,
): Promise<LLMResponse> {
  const client = options?.client ?? createOpenAIClient(options);
  const endpoint = resolveChatEndpoint(options);
  const model =
    options?.model ??
    process.env.OPENAI_CHAT_MODEL ??
    process.env.OPENAI_MODEL ??
    "gpt-4o-mini";

  const prompt = typeof input === "string" ? input : input.prompt;
  const inputImages =
    typeof input === "object" && input.images
      ? Array.isArray(input.images)
        ? input.images
        : [input.images]
      : [];
  const optionImages = options?.images
    ? Array.isArray(options.images)
      ? options.images
      : [options.images]
    : [];
  const images = [...inputImages, ...optionImages];

  const system =
    (typeof input === "object" ? input.system : undefined) ?? options?.system;

  let messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  if (typeof input === "object" && input.messages) {
    messages = [...input.messages];
  } else {
    if (system) {
      messages.push({ role: "system", content: system });
    }

    if (images.length > 0) {
      const contentParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] =
        [];
      if (prompt) {
        contentParts.push({ type: "text", text: prompt });
      }
      for (const img of images) {
        contentParts.push(normalizeImageContentPart(img));
      }
      messages.push({ role: "user", content: contentParts });
    } else if (prompt) {
      messages.push({ role: "user", content: prompt });
    }
  }

  const body: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
    model,
    messages,
  };

  if (options?.temperature !== undefined) {
    body.temperature = options.temperature;
  }
  if (options?.maxTokens !== undefined) {
    body.max_tokens = options.maxTokens;
  }
  if (options?.topP !== undefined) {
    body.top_p = options.topP;
  }
  if (options?.responseFormat !== undefined) {
    body.response_format = options.responseFormat;
  }

  const envEffort = process.env.OPENAI_REASONING_EFFORT;
  const defaultEffort =
    envEffort !== undefined ? envEffort || undefined : "low";
  const reasoningEffort =
    options?.reasoningEffort !== undefined
      ? options.reasoningEffort
      : options?.reasoning_effort !== undefined
        ? options.reasoning_effort
        : defaultEffort;

  if (reasoningEffort !== undefined && reasoningEffort !== null) {
    body.reasoning_effort = reasoningEffort as any;
  }

  const envThinking =
    process.env.OPENAI_MAX_THINKING_TOKENS ??
    process.env.MAX_THINKING_TOKENS ??
    process.env.OPENAI_THINKING_BUDGET;
  const defaultThinkingTokens =
    envThinking !== undefined
      ? envThinking === ""
        ? undefined
        : Number(envThinking)
      : 512;

  const maxThinkingTokens =
    options?.maxThinkingTokens !== undefined
      ? options.maxThinkingTokens
      : options?.max_thinking_tokens !== undefined
        ? options.max_thinking_tokens
        : options?.thinkingBudget !== undefined
          ? options.thinkingBudget
          : options?.thinking_budget !== undefined
            ? options.thinking_budget
            : defaultThinkingTokens;

  if (maxThinkingTokens !== undefined && maxThinkingTokens !== null) {
    (body as any).max_thinking_tokens = maxThinkingTokens;
    (body as any).thinking_budget = maxThinkingTokens;
  }

  const requestOptions: any = {
    path: endpoint,
    timeout: resolveTimeout(options, "chat"),
  };

  let completion: OpenAI.Chat.Completions.ChatCompletion;
  try {
    completion = await client.chat.completions.create(body, requestOptions);
  } catch (err: any) {
    if (err instanceof OpenAI.APIError) {
      let errorDetail = "";
      if (
        err.error &&
        typeof err.error === "object" &&
        "message" in err.error
      ) {
        errorDetail = String((err.error as any).message);
      } else if (err.message) {
        errorDetail = err.message;
      } else {
        errorDetail = JSON.stringify(err.error ?? "");
      }
      throw new Error(
        `OpenAI Chat API error (HTTP ${err.status} from ${endpoint}): ${errorDetail}`,
      );
    }
    if (
      err instanceof OpenAI.APIConnectionError ||
      err instanceof OpenAI.APIConnectionTimeoutError
    ) {
      throw new Error(
        `Failed to connect to chat endpoint at ${endpoint}: ${(err.cause as any)?.message || err.message}`,
      );
    }
    throw err;
  }

  const choice = completion.choices?.[0];
  const message = choice?.message as any;
  const rawContent = message?.content || "";
  const reasoningContent =
    message?.reasoning_content || (message as any)?.reasoning || undefined;
  const content = rawContent || reasoningContent || "";

  return {
    content,
    reasoningContent,
    model: completion.model || model,
    finishReason: choice?.finish_reason,
    usage: completion.usage
      ? {
          promptTokens: completion.usage.prompt_tokens,
          completionTokens: completion.usage.completion_tokens,
          totalTokens: completion.usage.total_tokens,
        }
      : undefined,
    raw: completion,
  };
}

/**
 * Queries an LLM with text and optional images.
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
  const result = await fetchOpenAIChatCompletion(input, options);
  if (options?.detailed) {
    return result;
  }
  return result.content;
}

export default {
  getEmbedding,
  getEmbeddings,
  resolveEmbeddingEndpoint,
  resolveChatEndpoint,
  normalizeVectorDimensions,
  normalizeImageContentPart,
  createOpenAIClient,
  fetchOpenAIEmbeddings,
  fetchOpenAIChatCompletion,
  queryLLM,
  isLocalEndpoint,
  resolveTimeout,
};
