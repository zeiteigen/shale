import { afterEach, beforeEach, expect, it } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { LLMClient } from "../sdk/llm";
import { EmbedderClient } from "../sdk/embed";
import { boundedMap } from "../lib/ai/bounded-map";
import { resolveBatchEndpoint } from "../lib/ai/batch-config";
import { embeddingProfile } from "../lib/embedding-profile";

const originalEnv = { ...process.env };
beforeEach(() => {
  process.env = { ...originalEnv };
  for (const key of Object.keys(process.env))
    if (/^(OPENAI_|EMBEDDING_|MODEL_BATCH_)/.test(key)) delete process.env[key];
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

it("splits embeddings into configured requests and preserves indices and provenance", async () => {
  const inputs: string[][] = [];
  const client = new EmbedderClient({ endpoint: "https://embedding.invalid/v1/embeddings", batchSize: 2,
    concurrency: 2, padToDimensions: 4, instruction: "find", fetchFn: async (_url: unknown, init: any) => {
      const body = JSON.parse(init?.body);
      inputs.push(body.input);
      await delay(body.input[0].endsWith("1") ? 5 : 1);
      return Response.json({ data: body.input.map((text: string, index: number) =>
        ({ index, embedding: [Number(text.split("Query: ")[1]), 2] })).reverse() });
    } });
  const results = await client.embedBatch(["1", "2", "3", "4", "5"]);
  expect(inputs.map(group => group.length)).toEqual([2, 2, 1]);
  expect(results.map(vector => vector[0])).toEqual([1, 2, 3, 4, 5]);
  expect(results.every(vector => vector.length === 4)).toBe(true);
  expect(embeddingProfile(results[4])?.endpoint).toBe("https://embedding.invalid/v1/embeddings");
  expect(embeddingProfile(results[4])?.instruction).toBe("find");
});

it("reads updated batch settings from the environment without recreating clients", async () => {
  const sizes: number[] = [];
  const client = new EmbedderClient({ baseUrl: "https://embedding.invalid/v1", padToDimensions: null,
    fetchFn: async (_url: unknown, init: any) => {
      const body = JSON.parse(init?.body);
      sizes.push(body.input.length);
      return Response.json({ data: body.input.map((_: string, index: number) => ({ index, embedding: [1, 2] })) });
    } });
  process.env.EMBEDDING_BATCH_SIZE = "2";
  await client.embedBatch(["a", "b", "c"]);
  process.env.EMBEDDING_BATCH_SIZE = "1";
  await client.embedBatch(["a", "b", "c"]);
  expect(sizes).toEqual([2, 1, 1, 1, 1]);
  process.env.EMBEDDING_BATCH_SIZE = "0";
  await expect(client.embedBatch(["a"])).rejects.toThrow("positive integer");
});

it("rejects inconsistent native embedding dimensions across sub-batches", async () => {
  let count = 0;
  const client = new EmbedderClient({ baseUrl: "https://embedding.invalid/v1", batchSize: 1, padToDimensions: 4,
    fetchFn: async () => Response.json({ data: [{ index: 0, embedding: ++count === 1 ? [1, 2] : [1, 2, 3] }] }) });
  await expect(client.embedBatch(["a", "b"])).rejects.toThrow("inconsistent native dimensions");
});

it("bounds padded embedding workload while preserving full oversized inputs, order, and provenance", async () => {
  const groups: string[][] = [];
  const instruction = "find";
  const texts = ["a", "b", "x".repeat(80), "z".repeat(250), "last"];
  const client = new EmbedderClient({ endpoint: "https://embedding.invalid/v1/embeddings",
    batchSize: 64, batchMaxChars: 200, instruction, padToDimensions: null,
    fetchFn: async (_url: unknown, init: any) => {
      const body = JSON.parse(init.body);
      groups.push(body.input);
      return Response.json({ data: body.input.map((text: string, index: number) => ({
        index, embedding: [texts.indexOf(text.split("Query: ")[1]) + 1, 2],
      })).reverse() });
    } });
  const vectors = await client.embedBatch(texts);
  expect(groups.map(group => group.length)).toEqual([2, 1, 1, 1]);
  expect(groups.flat()).toEqual(texts.map(text => `Instruct: ${instruction}\nQuery: ${text}`));
  expect(vectors.map(vector => vector[0])).toEqual([1, 2, 3, 4, 5]);
  expect(embeddingProfile(vectors[4])?.instruction).toBe(instruction);
  for (const group of groups) {
    if (group.length > 1) expect(Math.max(...group.map(text => text.length)) * group.length).toBeLessThanOrEqual(200);
  }
  process.env.EMBEDDING_BATCH_MAX_CHARS = "0";
  await expect(new EmbedderClient().embedBatch(["a"])).rejects.toThrow("positive integer");
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
  process.env.EMBEDDING_BATCH_ENDPOINT = "https://embed-batch.invalid/v1/batches";
  expect(resolveBatchEndpoint("chat")).toBe(process.env.OPENAI_CHAT_BATCH_ENDPOINT!);
  expect(resolveBatchEndpoint("embedding")).toBe(process.env.EMBEDDING_BATCH_ENDPOINT!);
  const client = new LLMClient({ batchEndpoint: "https://old.invalid/v1/batches" });
  expect(resolveBatchEndpoint("chat", client.options({ baseUrl: "https://new.invalid/v1" }))).toBe("https://new.invalid/v1/batches");
  expect(() => resolveBatchEndpoint("chat", { batchEndpoint: "file:///batches" })).toThrow("HTTP(S)");
  expect(resolveBatchEndpoint("chat", { endpoint: "https://custom.invalid/v1/chat/completions?version=1" }))
    .toBe("https://custom.invalid/v1/batches?version=1");
});
