import type OpenAI from "openai";

export type FetchFn = (
  url: RequestInfo | URL | string,
  init?: RequestInit | any,
) => Promise<Response>;

export interface AIClientOptions {
  /** Concurrent completion requests or the asynchronous OpenAI Batch API. */
  batchMode?: "concurrent" | "api";
  /** Full /batches URL; each role resolves its own endpoint. */
  batchEndpoint?: string;
  /** Overall Batch API deadline, independent of the HTTP request timeout. */
  batchTimeoutMs?: number;
  batchPollIntervalMs?: number;
  /** Persistent submitted batch IDs for recovery. SDK clients provide this automatically. */
  batchStore?: {
    get(key: string): { inputFileId: string; batchId?: string } | null;
    set(key: string, value: { inputFileId: string; batchId?: string }): void;
    delete(key: string): void;
  };
  apiKey?: string;
  baseUrl?: string;
  endpoint?: string;
  fetchFn?: FetchFn | typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  client?: OpenAI;
  /** Shared GPU identity; null disables coordination for this profile. */
  resource?: string | null;
  signal?: AbortSignal;
}

export interface EmbedderOptions extends AIClientOptions {
  /** Maximum texts per embedding request (default 64). */
  batchSize?: number;
  /** Maximum padded characters per synchronous request (default 16384); larger texts run alone. */
  batchMaxChars?: number;
  /** Maximum concurrent embedding requests (default 1). */
  concurrency?: number;
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
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;

export interface LLMOptions extends AIClientOptions {
  /** Maximum preparation tasks per dedicated chat batch (default 32). */
  batchSize?: number;
  /** Maximum concurrent chat requests in a batch (default 4). */
  concurrency?: number;
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
  /** Provider-specific request field. Null omits thinking token controls. */
  thinkingTokenField?: "max_thinking_tokens" | "thinking_budget" | null;
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
