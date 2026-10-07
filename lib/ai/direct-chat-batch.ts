import type OpenAI from "openai";
import { createOpenAIClient } from "./client";
import { resolveTimeout } from "./config";
import { batchProgress } from "./batch-progress";
import type { AIClientOptions } from "./types";

/** vLLM batches accept conversations in one POST and index choices by conversation. */
export async function executeDirectChatBatch<T>(
  endpoint: string, bodies: unknown[], options?: AIClientOptions,
): Promise<T[]> {
  const requests = bodies as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming[];
  const { messages: _messages, ...parameters } = requests[0];
  const signature = (body: typeof requests[number]) => JSON.stringify(
    Object.fromEntries(Object.entries(body).filter(([key]) => key !== "messages")
      .sort(([a], [b]) => a.localeCompare(b))),
  );
  if (requests.some(body => signature(body) !== signature(requests[0])))
    throw new Error("Direct chat batch requests must share generation parameters");
  const client = createOpenAIClient({ ...options, endpoint }, "chat");
  const timeout = resolveTimeout({ ...options, endpoint }, "chat");
  const deadline = AbortSignal.timeout(timeout);
  const signal = options?.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const report = batchProgress("chat", requests.length);
  report("submitting direct batch");
  try {
    const completion = await client.post<OpenAI.Chat.Completions.ChatCompletion>(endpoint, {
      body: { ...parameters, messages: requests.map(body => body.messages) },
      // A timeout applies to the entire batch, including SDK retries.
      timeout, signal,
    });
    if (!Array.isArray(completion.choices) || completion.choices.length !== requests.length)
      throw new Error(`Direct chat batch must contain exactly ${requests.length} choices`);
    const results = new Array<T>(requests.length);
    const seen = new Set<number>();
    for (const choice of completion.choices) {
      if (!Number.isInteger(choice.index) || choice.index < 0 || choice.index >= requests.length || seen.has(choice.index))
        throw new Error("Direct chat batch has invalid or duplicate choice indices");
      if (!choice.message || choice.message.role !== "assistant")
        throw new Error(`Direct chat batch choice ${choice.index} has no assistant message`);
      seen.add(choice.index);
      // The server reports aggregate usage; it cannot be attributed to individual conversations.
      const { usage: _usage, ...metadata } = completion;
      results[choice.index] = { ...metadata, choices: [{ ...choice, index: 0 }] } as T;
    }
    report("finished direct batch", requests.length);
    return results;
  } catch (error) {
    report("interrupted direct batch");
    if (deadline.aborted && !options?.signal?.aborted)
      throw new Error(`Direct chat batch at ${endpoint} exceeded its ${timeout}ms total timeout`, { cause: error });
    throw new Error(`Direct chat batch at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
