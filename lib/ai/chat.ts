import type OpenAI from "openai";
import type { LLMOptions, LLMQueryInput, LLMResponse } from "./types";
import { createOpenAIClient } from "./client";
import { resolveChatEndpoint, resolveTimeout } from "./config";
import { normalizeImageContentPart } from "./images";
import { modelRequest } from "./request";
import { normalizeChatOptions } from "./options";

/**
 * Queries an OpenAI-compatible chat completion model with support for text and images.
 */
export async function fetchOpenAIChatCompletion(
  input: string | LLMQueryInput,
  options?: LLMOptions,
): Promise<LLMResponse> {
  options = normalizeChatOptions(options);
  const client = createOpenAIClient(options, "chat");
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

  if ((typeof input === "object" && input.messages) || options.messages) {
    messages = [
      ...(typeof input === "object" && input.messages
        ? input.messages
        : options.messages!),
    ];
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
    options.reasoningEffort !== undefined
      ? options.reasoningEffort
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
    options.maxThinkingTokens !== undefined
      ? options.maxThinkingTokens
      : defaultThinkingTokens;

  if (maxThinkingTokens !== undefined && maxThinkingTokens !== null) {
    if (!Number.isInteger(maxThinkingTokens) || maxThinkingTokens < 0) {
      throw new Error("Thinking token budget must be a nonnegative integer");
    }
    const field =
      options.thinkingTokenField === undefined
        ? "max_thinking_tokens"
        : options.thinkingTokenField;
    if (field) (body as any)[field] = maxThinkingTokens;
  }

  const requestOptions: any = {
    path: endpoint,
    timeout: resolveTimeout(options, "chat"),
    signal: options.signal,
  };

  const completion = await modelRequest(
    "chat",
    endpoint,
    () => client.chat.completions.create(body, requestOptions),
    options?.resource,
  );

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
