import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import OpenAI from "openai";
import { LLMClient } from "../sdk/llm";
import { resolveChatEndpoint, resolveTimeout, resolveRetries, isLocalEndpoint } from "../lib/ai/config";

const originalEnv = { ...process.env };
beforeEach(() => {
  process.env = { ...originalEnv };
  for (const key of Object.keys(process.env)) if (/^(OPENAI_|MODEL_TIMEOUT_MS$|CHAT_TIMEOUT_MS$|MAX_THINKING_TOKENS$)/.test(key)) delete process.env[key];
});
afterEach(() => { process.env = { ...originalEnv }; });

it("exposes the effective chat model freshly and honors profile and request overrides", () => {
  const chat = new LLMClient();
  process.env.OPENAI_CHAT_MODEL = "first-chat";
  expect(chat.options().model).toBe("first-chat");
  process.env.OPENAI_CHAT_MODEL = "second-chat";
  expect(chat.options().model).toBe("second-chat");
  expect(new LLMClient({ model: "profile-chat" }).options().model).toBe("profile-chat");
  expect(chat.options({ model: "request-chat" }).model).toBe("request-chat");
});

function transport() {
  const calls: Array<{ url: string; authorization: string | null; body: any }> = [];
  const fetchFn = async (url: any, init: any) => {
    calls.push({ url: String(url), authorization: new Headers(init.headers).get("authorization"), body: JSON.parse(init.body) });
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  };
  return { calls, fetchFn };
}

describe("Chat model profile configuration", () => {
  it("treats blank credentials as absent for local chat requests", async () => {
    process.env.OPENAI_API_KEY = "";
    process.env.OPENAI_CHAT_API_KEY = " ";
    const { fetchFn, calls } = transport();
    await new LLMClient({ baseUrl: "http://localhost:11434/v1", apiKey: "", fetchFn }).query("hello");
    expect(calls[0].authorization).toBe("Bearer dummy");
  });

  it("honors an injected client's URL and per-call credentials without losing its transport", async () => {
    const { calls, fetchFn } = transport();
    const injected = new OpenAI({ baseURL: "http://custom.invalid/v1", apiKey: "injected", fetch: fetchFn });
    const client = new LLMClient(injected);
    await client.query("one");
    await client.query("two", { apiKey: "override", baseUrl: "http://override.invalid/v1" });
    expect(calls.map(call => [call.url, call.authorization])).toEqual([
      ["http://custom.invalid/v1/chat/completions", "Bearer injected"],
      ["http://override.invalid/v1/chat/completions", "Bearer override"],
    ]);
    expect(client.client).toBe(injected);
    expect(resolveTimeout({ client: new OpenAI({ apiKey: "test", timeout: 1234 }) })).toBe(1234);
  });

  it("reads chat credentials and reasoning defaults freshly on every request", async () => {
    const { calls, fetchFn } = transport();
    process.env.OPENAI_API_KEY = "before";
    const chat = new LLMClient({ fetchFn });
    await chat.query("first");
    process.env.OPENAI_API_KEY = "after";
    process.env.OPENAI_REASONING_EFFORT = "minimal";
    process.env.OPENAI_MAX_THINKING_TOKENS = "768";
    await chat.query("second");
    expect(calls.map(call => call.authorization)).toEqual(["Bearer before", "Bearer after"]);
    expect(calls[1].body.reasoning_effort).toBe("minimal");
    expect(calls[1].body.max_thinking_tokens).toBe(768);
  });

  it("lets per-call connection overrides replace a profile connection", async () => {
    const { calls, fetchFn } = transport();
    const chat = new LLMClient({ endpoint: "https://profile.invalid/v1/chat/completions", apiKey: "profile", fetchFn });
    await chat.query("one", { baseUrl: "https://call.invalid/v1" });
    const injected = new OpenAI({ baseURL: "https://injected.invalid/v1", apiKey: "injected", fetch: fetchFn });
    await chat.query("two", { client: injected });
    expect(calls.map(call => [call.url, call.authorization])).toEqual([
      ["https://call.invalid/v1/chat/completions", "Bearer profile"],
      ["https://injected.invalid/v1/chat/completions", "Bearer injected"],
    ]);
  });

  it("normalizes reasoning aliases, preserves defaults for undefined, and lets null disable controls", async () => {
    const { calls, fetchFn } = transport();
    const chat = new LLMClient({ fetchFn, max_thinking_tokens: 800, reasoningEffort: "high" });
    await chat.query("one", { thinking_budget: 100, reasoning_effort: "low" });
    await chat.query("two", { maxThinkingTokens: undefined, reasoningEffort: undefined });
    await chat.query("three", { maxThinkingTokens: null, reasoningEffort: null });
    await chat.query("four", { thinkingTokenField: "thinking_budget" });
    expect(calls[0].body.max_thinking_tokens).toBe(100);
    expect(calls[0].body.reasoning_effort).toBe("low");
    expect(calls[1].body.max_thinking_tokens).toBe(800);
    expect(calls[2].body.max_thinking_tokens).toBeUndefined();
    expect(calls[2].body.reasoning_effort).toBeUndefined();
    expect(calls[3].body.thinking_budget).toBe(800);
    expect(calls[3].body.max_thinking_tokens).toBeUndefined();
  });

  it("derives timeouts from the chat endpoint and validates retry settings", () => {
    process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";
    expect(resolveChatEndpoint()).toBe("http://localhost:11434/v1/chat/completions");
    expect(resolveTimeout()).toBe(300_000);
    process.env.OPENAI_MAX_RETRIES = "0";
    expect(resolveRetries()).toBe(0);
    expect(isLocalEndpoint("http://[::1]:8080/v1")).toBe(true);
    expect(() => resolveTimeout({ timeoutMs: -1 })).toThrow("integer");
  });
});
