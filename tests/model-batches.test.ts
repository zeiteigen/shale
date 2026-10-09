import { afterEach, beforeEach, expect, it } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { LLMClient } from "../sdk/llm";
import { boundedMap } from "../lib/ai/bounded-map";
import { resolveBatchEndpoint } from "../lib/ai/batch-config";

const originalEnv = { ...process.env };
beforeEach(() => {
  process.env = { ...originalEnv };
  for (const key of Object.keys(process.env))
    if (/^(OPENAI_|MODEL_BATCH_)/.test(key)) delete process.env[key];
});
afterEach(() => { process.env = { ...originalEnv }; });

it("bounds concurrent chat requests across simultaneous batches and preserves order", async () => {
  let active = 0, peak = 0;
  const client = new LLMClient({ endpoint: "https://chat.invalid/v1/chat/completions", concurrency: 2,
    fetchFn: async (_url: unknown, init: any) => {
      const prompt = JSON.parse(init?.body).messages[0].content;
      peak = Math.max(peak, ++active);
      await delay(prompt === "slow" ? 10 : 1);
      active--;
      return Response.json({ choices: [{ message: { content: prompt } }] });
    } });
  const results = await Promise.all([client.queryBatch(["slow", "fast", "last"]), client.queryBatch(["other", "final"])]);
  expect(results).toEqual([["slow", "fast", "last"], ["other", "final"]]);
  expect(peak).toBe(2);
  expect(active).toBe(0);
});

it("drains started tasks on failure and stops scheduling new tasks", async () => {
  const started: number[] = [];
  let drained = false;
  await expect(boundedMap([0, 1, 2, 3], 2, async item => {
    started.push(item);
    if (item === 0) throw new Error("failed");
    await delay(5);
    drained = true;
  })).rejects.toThrow("failed");
  expect(started).toEqual([0, 1]);
  expect(drained).toBe(true);
});

it("resolves independent batch endpoints and lets per-call connection overrides replace defaults", () => {
  process.env.OPENAI_CHAT_BATCH_ENDPOINT = "https://chat-batch.invalid/v1/batches";
  expect(resolveBatchEndpoint("chat")).toBe(process.env.OPENAI_CHAT_BATCH_ENDPOINT!);
  const client = new LLMClient({ batchEndpoint: "https://old.invalid/v1/batches" });
  expect(resolveBatchEndpoint("chat", client.options({ baseUrl: "https://new.invalid/v1" }))).toBe("https://new.invalid/v1/batches");
  expect(() => resolveBatchEndpoint("chat", { batchEndpoint: "file:///batches" })).toThrow("HTTP(S)");
  expect(resolveBatchEndpoint("chat", { endpoint: "https://custom.invalid/v1/chat/completions?version=1" }))
    .toBe("https://custom.invalid/v1/batches?version=1");
});
