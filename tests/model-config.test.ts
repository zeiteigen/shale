import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import OpenAI from "openai";
import { Database } from "bun:sqlite";
import { createExtensionSDK } from "../sdk";
import { LLMClient } from "../sdk/llm";
import { EmbedderClient } from "../sdk/embed";
import {
  resolveChatEndpoint,
  resolveEmbeddingEndpoint,
  resolveTimeout,
  resolveRetries,
  isLocalEndpoint,
} from "../lib/ai/config";

const originalEnv = { ...process.env };
beforeEach(() => {
  process.env = { ...originalEnv };
  for (const key of Object.keys(process.env)) {
    if (
      /^(OPENAI_|EMBEDDING_|MODEL_TIMEOUT_MS$|CHAT_TIMEOUT_MS$|MAX_THINKING_TOKENS$)/.test(
        key,
      )
    )
      delete process.env[key];
  }
});
afterEach(() => {
  process.env = { ...originalEnv };
});

it("exposes effective model identities freshly for graph provenance and honors profile overrides", () => {
  const chat = new LLMClient();
  const embedding = new EmbedderClient();
  process.env.OPENAI_CHAT_MODEL = "first-chat";
  process.env.OPENAI_EMBEDDING_MODEL = "first-embedding";
  expect(chat.options().model).toBe("first-chat");
  expect(embedding.options().model).toBe("first-embedding");
  process.env.OPENAI_CHAT_MODEL = "second-chat";
  process.env.OPENAI_EMBEDDING_MODEL = "second-embedding";
  expect(chat.options().model).toBe("second-chat");
  expect(embedding.options().model).toBe("second-embedding");
  expect(new LLMClient({ model: "profile-chat" }).options().model).toBe("profile-chat");
  expect(new EmbedderClient({ model: "profile-embedding" }).options().model).toBe("profile-embedding");
  expect(chat.options({ model: "request-chat" }).model).toBe("request-chat");
  expect(embedding.options({ model: "request-embedding" }).model).toBe("request-embedding");
});

function transport() {
  const calls: Array<{ url: string; authorization: string | null; body: any }> =
    [];
  const fetchFn = async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({
      url: String(url),
      authorization: new Headers(init.headers).get("authorization"),
      body,
    });
    return Response.json(
      body.input
        ? {
            data: body.input.map((_: string, index: number) => ({
              index,
              embedding: [1, 2],
            })),
          }
        : { choices: [{ message: { content: "ok" } }] },
    );
  };
  return { calls, fetchFn };
}

describe("Model profile configuration", () => {
  it("treats blank credentials as absent for local chat and embedding requests", async () => {
    process.env.OPENAI_API_KEY = "";
    process.env.OPENAI_CHAT_API_KEY = " ";
    process.env.EMBEDDING_API_KEY = "";
    const { fetchFn, calls } = transport();
    const llm = new LLMClient({ baseUrl: "http://localhost:11434/v1", apiKey: "", fetchFn });
    const embedder = new EmbedderClient({ baseUrl: "http://localhost:11434/v1", fetchFn });
    await llm.query("hello");
    await embedder.embed("hello");
    expect(calls.map((call) => call.authorization)).toEqual(["Bearer dummy", "Bearer dummy"]);
  });

  it("keeps chat and embedding endpoints independent while sharing explicit transport defaults", async () => {
    const { calls, fetchFn } = transport();
    const database = new Database(":memory:");
    const sdk = createExtensionSDK("profiles", {
      database,
      models: {
        connection: { fetchFn, apiKey: "shared-test" },
        chat: { endpoint: "http://chat.invalid/v1/chat/completions" },
        embedding: { endpoint: "http://embedding.invalid/v1/embeddings" },
      },
    });
    await sdk.queryLLM("hello");
    await sdk.embed("hello");
    expect(calls.map((call) => call.url)).toEqual([
      "http://chat.invalid/v1/chat/completions",
      "http://embedding.invalid/v1/embeddings",
    ]);
    expect(
      calls.every((call) => call.authorization === "Bearer shared-test"),
    ).toBe(true);
    database.close();
  });

  it("honors an injected client's URL and applies per-call credentials without losing its fetch transport", async () => {
    const { calls, fetchFn } = transport();
    const injected = new OpenAI({
      baseURL: "http://custom.invalid/v1",
      apiKey: "injected",
      fetch: fetchFn,
    });
    const client = new LLMClient(injected);
    await client.query("one");
    await client.query("two", {
      apiKey: "override",
      baseUrl: "http://override.invalid/v1",
    });
    expect(calls.map((call) => [call.url, call.authorization])).toEqual([
      ["http://custom.invalid/v1/chat/completions", "Bearer injected"],
      ["http://override.invalid/v1/chat/completions", "Bearer override"],
    ]);
    expect(client.client).toBe(injected);
    expect(
      resolveTimeout({ client: new OpenAI({ apiKey: "test", timeout: 1234 }) }),
    ).toBe(1234);
  });

  it("reads environment credentials and reasoning defaults freshly on every request", async () => {
    const { calls, fetchFn } = transport();
    const embedding = new EmbedderClient({ fetchFn });
    process.env.EMBEDDING_API_KEY = "before";
    await embedding.embed("first");
    process.env.EMBEDDING_API_KEY = "after";
    await embedding.embed("second");
    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer before",
      "Bearer after",
    ]);
    const chat = new LLMClient({ fetchFn });
    process.env.OPENAI_REASONING_EFFORT = "minimal";
    process.env.OPENAI_MAX_THINKING_TOKENS = "768";
    await chat.query("hello");
    expect(calls[2].body.reasoning_effort).toBe("minimal");
    expect(calls[2].body.max_thinking_tokens).toBe(768);
  });

  it("lets a per-call base URL or injected client replace a profile's connection", async () => {
    const { calls, fetchFn } = transport();
    const chat = new LLMClient({
      endpoint: "https://profile.invalid/v1/chat/completions",
      apiKey: "profile",
      fetchFn,
    });
    await chat.query("one", { baseUrl: "https://call.invalid/v1" });
    const injected = new OpenAI({
      baseURL: "https://injected.invalid/v1",
      apiKey: "injected",
      fetch: fetchFn,
    });
    await chat.query("two", { client: injected });
    expect(calls.map((call) => [call.url, call.authorization])).toEqual([
      ["https://call.invalid/v1/chat/completions", "Bearer profile"],
      ["https://injected.invalid/v1/chat/completions", "Bearer injected"],
    ]);
  });

  it("normalizes aliases before merging, preserves defaults for undefined, and lets null disable controls", async () => {
    const { calls, fetchFn } = transport();
    const chat = new LLMClient({
      fetchFn,
      max_thinking_tokens: 800,
      reasoningEffort: "high",
    });
    await chat.query("one", { thinking_budget: 100, reasoning_effort: "low" });
    await chat.query("two", {
      maxThinkingTokens: undefined,
      reasoningEffort: undefined,
    });
    await chat.query("three", {
      maxThinkingTokens: null,
      reasoningEffort: null,
    });
    await chat.query("four", { thinkingTokenField: "thinking_budget" });
    expect(calls[0].body.max_thinking_tokens).toBe(100);
    expect(calls[0].body.reasoning_effort).toBe("low");
    expect(calls[1].body.max_thinking_tokens).toBe(800);
    expect(calls[2].body.max_thinking_tokens).toBeUndefined();
    expect(calls[2].body.reasoning_effort).toBeUndefined();
    expect(calls[3].body.thinking_budget).toBe(800);
    expect(calls[3].body.max_thinking_tokens).toBeUndefined();
  });

  it("derives timeout from the actual endpoint and gives explicit base URLs priority over environment endpoints", () => {
    process.env.OPENAI_BASE_URL = "https://cloud.invalid/v1";
    process.env.EMBEDDING_ENDPOINT = "http://localhost:11434/v1/embeddings";
    expect(resolveTimeout(undefined, "embedding")).toBe(300_000);
    expect(
      resolveEmbeddingEndpoint({ baseUrl: "https://explicit.invalid/v1" }),
    ).toBe("https://explicit.invalid/v1/embeddings");
    process.env.OPENAI_MAX_RETRIES = "0";
    expect(
      resolveRetries(
        { endpoint: "http://localhost/v1/embeddings" },
        "embedding",
      ),
    ).toBe(0);
    expect(isLocalEndpoint("http://[::1]:8080/v1")).toBe(true);
    expect(() =>
      resolveChatEndpoint({ endpoint: "http://localhost/v1/embeddings" }),
    ).toThrow("other model role");
    expect(() => resolveTimeout({ timeoutMs: -1 })).toThrow("integer");
  });
});
