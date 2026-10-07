import { expect, it } from "bun:test";
import { LLMClient } from "../sdk/llm";
import type { FetchFn } from "../lib/ai/types";
import { collectBatchRequests } from "../lib/ai/batch-dispatch";
import { executeDirectChatBatch } from "../lib/ai/direct-chat-batch";

const endpoint = "https://batch.invalid/upstream/model/v1/chat/completions/batch";
function client(fetchFn: FetchFn) {
  return new LLMClient({ batchMode: "api", batchEndpoint: endpoint, fetchFn,
    model: "test", maxRetries: 0, reasoningEffort: null, maxThinkingTokens: null });
}
const response = (body: any) => ({ id: "batch", object: "chat.completion", created: 1, model: body.model,
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  choices: body.messages.map((messages: any[], index: number) => ({ index,
    message: { role: "assistant", content: messages.at(-1).content, reasoning: `reason-${index}` },
    finish_reason: "stop" })).reverse() });

it("posts conversations together, restores choice order, and preserves multimodal and JSON options", async () => {
  const calls: any[] = [];
  const llm = client((async (url: any, init: any) => {
    expect(String(url)).toBe(endpoint);
    const body = JSON.parse(init.body); calls.push(body);
    return Response.json(response(body));
  }) as FetchFn);
  const inputs = ["first", "second", "third"];
  const results = await llm.queryBatch(inputs, { detailed: true, temperature: 0.1, responseFormat: { type: "json_object" } });
  expect(calls).toHaveLength(1);
  expect(calls[0].messages).toEqual(inputs.map(content => [{ role: "user", content }]));
  expect(calls[0].response_format).toEqual({ type: "json_object" });
  expect(results.map(result => result.content)).toEqual(inputs);
  expect(results.map(result => result.reasoningContent)).toEqual(["reason-0", "reason-1", "reason-2"]);
  expect(results.every(result => result.usage === undefined)).toBe(true);
  await llm.queryBatch([{ prompt: "image", images: "https://example.com/image.png" }]);
  expect(calls[1].messages[0][0].content[1].type).toBe("image_url");
});

it("separates incompatible generation settings within one collection scope", async () => {
  const calls: any[] = [];
  const llm = client((async (_url: any, init: any) => {
    const body = JSON.parse(init.body); calls.push(body);
    return Response.json(response(body));
  }) as FetchFn);
  expect(await collectBatchRequests(() => Promise.all([
    llm.query("cold", { temperature: 0 }), llm.query("warm", { temperature: 1 }),
    llm.query("also cold", { temperature: 0 }),
  ]))).toEqual(["cold", "warm", "also cold"]);
  expect(calls).toHaveLength(2);
  expect(calls.find(body => body.temperature === 0).messages).toHaveLength(2);
});

it("rejects incomplete, duplicate, and invalid choices instead of misassigning answers", async () => {
  for (const indices of [[0], [0, 0], [-1, 1], [0, 2]]) {
    const llm = client((async () => Response.json({ choices: indices.map(index => ({ index,
      message: { role: "assistant", content: "answer" } })) })) as FetchFn);
    await expect(llm.queryBatch(["a", "b"])).rejects.toThrow("Direct chat batch");
  }
});

it("surfaces direct endpoint HTTP errors and cancellation", async () => {
  const llm = client((async () => Response.json({ error: { message: "overloaded" } }, { status: 503 })) as FetchFn);
  await expect(llm.queryBatch(["a"])).rejects.toThrow("503");
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await expect(llm.queryBatch(["a"], { signal: controller.signal })).rejects.toThrow("cancelled");
});

it("rejects token-truncated responses so unfinished reasoning cannot become ingested text", async () => {
  const llm = client((async () => Response.json({ choices: [{ index: 0, finish_reason: "length",
    message: { role: "assistant", content: "", reasoning: "Unfinished thoughts" } }] })) as FetchFn);
  await expect(llm.queryBatch(["a"])).rejects.toThrow("truncated by its token limit");
});

it("bounds the entire native batch so SDK retries cannot resubmit after its deadline", async () => {
  let calls = 0;
  const fetchFn = (async (_url: any, init: any) => {
    calls++;
    return await new Promise<Response>((_resolve, reject) => {
      const fail = () => reject(new DOMException("Aborted", "AbortError"));
      if (init.signal.aborted) fail();
      else init.signal.addEventListener("abort", fail, {once:true});
    });
  }) as FetchFn;
  await expect(executeDirectChatBatch(endpoint, [{model:"test",messages:[{role:"user",content:"a"}]}],
    {fetchFn,timeoutMs:50,maxRetries:2})).rejects.toThrow("50ms total timeout");
  expect(calls).toBe(1);
});
