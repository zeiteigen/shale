import type OpenAI from "openai";

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
  /** Shared GPU identity; null disables coordination for this profile. */
  resource?: string | null;
  signal?: AbortSignal;
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
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;

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
