import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import {
  queryLLM,
  createOpenAIClient,
  resolveChatEndpoint,
  isLocalEndpoint,
  resolveTimeout,
  type FetchFn,
  type LLMOptions,
} from "../lib/ai";
import {
  createExtensionSDK,
  runWithSDK,
  queryLLM as sdkQueryLLM,
  LLMClient,
} from "../sdk";

describe("LLM Querying & Multimodal Integration", () => {
  const originalEnv = { ...process.env };
  const tempDir = join(import.meta.dir, "fixtures");
  const tempImagePath = join(tempDir, "sample-test.png");

  beforeEach(() => {
    process.env = { ...originalEnv };
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }
  });

  afterEach(() => {
    process.env = originalEnv;
    if (existsSync(tempImagePath)) {
      unlinkSync(tempImagePath);
    }
  });

  describe("Endpoint Resolution", () => {
    it("resolves default chat completions endpoint when no env variables are set", () => {
      delete process.env.OPENAI_BASE_URL;
      delete process.env.OPENAI_CHAT_ENDPOINT;
      delete process.env.OPENAI_ENDPOINT;

      expect(resolveChatEndpoint()).toBe(
        "https://api.openai.com/v1/chat/completions",
      );
    });

    it("appends /chat/completions to OPENAI_BASE_URL", () => {
      process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";
      expect(resolveChatEndpoint()).toBe(
        "http://localhost:11434/v1/chat/completions",
      );
    });

    it("respects explicit OPENAI_CHAT_ENDPOINT override", () => {
      process.env.OPENAI_CHAT_ENDPOINT =
        "https://custom-gateway.local/v1/chat/completions";
      expect(resolveChatEndpoint()).toBe(
        "https://custom-gateway.local/v1/chat/completions",
      );
    });
  });

  describe("Timeout & Local Model Cold-Load Resolution", () => {
    it("identifies localhost and local IPs as local endpoints", () => {
      expect(isLocalEndpoint("http://localhost:8080/v1")).toBe(true);
      expect(isLocalEndpoint("http://127.0.0.1:11434/v1")).toBe(true);
      expect(isLocalEndpoint("http://0.0.0.0:8000/v1")).toBe(true);
      expect(isLocalEndpoint("https://api.openai.com/v1")).toBe(false);
      expect(isLocalEndpoint("https://openrouter.ai/api/v1")).toBe(false);
    });

    it("allocates 300,000ms (5 mins) default timeout for local endpoints to allow cold model weight loading", () => {
      delete process.env.MODEL_TIMEOUT_MS;
      delete process.env.OPENAI_TIMEOUT_MS;
      delete process.env.CHAT_TIMEOUT_MS;
      process.env.OPENAI_BASE_URL = "http://localhost:8080/v1";

      const timeout = resolveTimeout(undefined, "chat");
      expect(timeout).toBe(300000);
    });

    it("allocates the local-model timeout when an embedding endpoint is configured directly", () => {
      delete process.env.MODEL_TIMEOUT_MS;
      delete process.env.OPENAI_TIMEOUT_MS;
      delete process.env.EMBEDDING_TIMEOUT_MS;
      delete process.env.OPENAI_BASE_URL;
      process.env.EMBEDDING_ENDPOINT = "http://localhost:11434/v1/embeddings";

      expect(resolveTimeout(undefined, "embedding")).toBe(300000);
      delete process.env.EMBEDDING_ENDPOINT;
    });

    it("uses 60,000ms default for cloud endpoints", () => {
      delete process.env.MODEL_TIMEOUT_MS;
      delete process.env.OPENAI_TIMEOUT_MS;
      delete process.env.CHAT_TIMEOUT_MS;
      process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";

      const timeout = resolveTimeout(undefined, "chat");
      expect(timeout).toBe(60000);
    });

    it("respects explicit environment variable and options timeout overrides", () => {
      process.env.MODEL_TIMEOUT_MS = "450000";
      expect(resolveTimeout(undefined, "chat")).toBe(450000);

      // Explicit options override takes highest priority
      expect(resolveTimeout({ timeoutMs: 15000 }, "chat")).toBe(15000);
    });
  });

  describe("Text Querying", () => {
    it("queries LLM with prompt and returns text response", async () => {
      let interceptedUrl = "";
      let interceptedBody: any = null;

      const mockFetch: FetchFn = async (url, init) => {
        interceptedUrl = url.toString();
        interceptedBody = JSON.parse(init?.body as string);

        return new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            model: interceptedBody.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "The capital of France is Paris.",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 7,
              total_tokens: 19,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const result = await queryLLM("What is the capital of France?", {
        fetchFn: mockFetch,
        model: "gpt-4o-mini",
        apiKey: "sk-test",
        baseUrl: "https://api.openai.com/v1",
      });

      expect(interceptedUrl).toBe("https://api.openai.com/v1/chat/completions");
      expect(interceptedBody.model).toBe("gpt-4o-mini");
      expect(interceptedBody.messages).toEqual([
        { role: "user", content: "What is the capital of France?" },
      ]);
      expect(result).toBe("The capital of France is Paris.");
    });

    it("supports system prompt and completion parameters", async () => {
      let interceptedBody: any = null;

      const mockFetch: FetchFn = async (_url, init) => {
        interceptedBody = JSON.parse(init?.body as string);

        return new Response(
          JSON.stringify({
            id: "chatcmpl-2",
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "System acknowledged." },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      await queryLLM("Hello", {
        fetchFn: mockFetch,
        system: "You are a concise AI.",
        temperature: 0.2,
        maxTokens: 50,
      });

      expect(interceptedBody.messages).toEqual([
        { role: "system", content: "You are a concise AI." },
        { role: "user", content: "Hello" },
      ]);
      expect(interceptedBody.temperature).toBe(0.2);
      expect(interceptedBody.max_tokens).toBe(50);
    });

    it("returns detailed response when detailed: true is specified", async () => {
      const mockFetch: FetchFn = async () => {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-3",
            object: "chat.completion",
            model: "gpt-4o-mini",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Detailed test." },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 5,
              completion_tokens: 3,
              total_tokens: 8,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const detailed = await queryLLM("Hello", {
        fetchFn: mockFetch,
        detailed: true,
      });

      expect(detailed.content).toBe("Detailed test.");
      expect(detailed.model).toBe("gpt-4o-mini");
      expect(detailed.finishReason).toBe("stop");
      expect(detailed.usage?.totalTokens).toBe(8);
      expect(detailed.raw.id).toBe("chatcmpl-3");
    });
  });

  describe("Multimodal Images Support", () => {
    it("formats web image URLs into user message content parts", async () => {
      let interceptedBody: any = null;

      const mockFetch: FetchFn = async (_url, init) => {
        interceptedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "A golden retriever." },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const res = await queryLLM("What breed is this dog?", {
        fetchFn: mockFetch,
        images: ["https://example.com/dog.jpg"],
      });

      expect(res).toBe("A golden retriever.");
      expect(interceptedBody.messages[0]).toEqual({
        role: "user",
        content: [
          { type: "text", text: "What breed is this dog?" },
          {
            type: "image_url",
            image_url: { url: "https://example.com/dog.jpg" },
          },
        ],
      });
    });

    it("formats local disk images as base64 data URLs", async () => {
      // Write sample image file
      writeFileSync(tempImagePath, Buffer.from("fake-png-content"));

      let interceptedBody: any = null;
      const mockFetch: FetchFn = async (_url, init) => {
        interceptedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Chart detected." },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const res = await queryLLM(
        {
          prompt: "Analyze chart",
          images: [tempImagePath],
        },
        {
          fetchFn: mockFetch,
        },
      );

      expect(res).toBe("Chart detected.");
      const userContent = interceptedBody.messages[0].content;
      expect(userContent[0]).toEqual({ type: "text", text: "Analyze chart" });
      expect(userContent[1].type).toBe("image_url");
      expect(userContent[1].image_url.url).toStartWith(
        "data:image/png;base64,",
      );
    });

    it("formats binary Buffer and image objects with detail", async () => {
      let interceptedBody: any = null;
      const mockFetch: FetchFn = async (_url, init) => {
        interceptedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Binary inspected." },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const imgBuffer = Buffer.from("binary-image-data");

      await queryLLM("Examine", {
        fetchFn: mockFetch,
        images: [
          imgBuffer,
          { url: "https://example.com/high.jpg", detail: "high" },
        ],
      });

      const parts = interceptedBody.messages[0].content;
      expect(parts.length).toBe(3);
      expect(parts[0]).toEqual({ type: "text", text: "Examine" });
      expect(parts[1].image_url.url).toStartWith("data:image/jpeg;base64,");
      expect(parts[2]).toEqual({
        type: "image_url",
        image_url: { url: "https://example.com/high.jpg", detail: "high" },
      });
    });
  });

  describe("SDK & Ambient Context Integration", () => {
    it("provides queryLLM via ShaleSDK instance and LLMClient", async () => {
      const mockFetch: FetchFn = async () => {
        return new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "SDK response." },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const sdk = createExtensionSDK("test-llm-ext", undefined, undefined, {
        apiKey: "shared-key",
        baseUrl: "https://mock-ai.com/v1",
        fetchFn: mockFetch,
      });

      expect(sdk.llm).toBeInstanceOf(LLMClient);
      expect(sdk.llm.client).toBeInstanceOf(OpenAI);

      const reply = await sdk.queryLLM("Hello SDK");
      expect(reply).toBe("SDK response.");

      const detailed = await sdk.llm.complete("Hello complete");
      expect(detailed.content).toBe("SDK response.");
    });

    it("supports top-level queryLLM convenience function within ambient context", async () => {
      const mockFetch: FetchFn = async () => {
        return new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Ambient response." },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const sdk = createExtensionSDK("test-ambient-ext", undefined, undefined, {
        fetchFn: mockFetch,
      });

      const reply = await runWithSDK(sdk, async () => {
        return sdkQueryLLM("Hello ambient");
      });

      expect(reply).toBe("Ambient response.");
    });

    it("throws descriptive error when chat API returns error status", async () => {
      const mockFetch: FetchFn = async () => {
        return new Response(
          JSON.stringify({
            error: { message: "Model overloaded. Please try again." },
          }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      };

      expect(
        queryLLM("Test fail", {
          fetchFn: mockFetch,
          apiKey: "sk-key",
        }),
      ).rejects.toThrow(/OpenAI Chat API error \(HTTP 503/);
    });
  });

  describe("Reasoning Effort Configuration", () => {
    it("defaults reasoning_effort to 'low' in chat completions payload", async () => {
      let interceptedBody: any = null;
      const mockFetch: FetchFn = async (_url, init) => {
        interceptedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      await queryLLM("Explain concept", {
        fetchFn: mockFetch,
        apiKey: "sk-key",
      });

      expect(interceptedBody.reasoning_effort).toBe("low");
    });

    it("defaults reasoning_effort to 'low' at SDK level via sdk.queryLLM and sdk.llm.complete", async () => {
      let interceptedBody: any = null;
      const mockFetch: FetchFn = async (_url, init) => {
        interceptedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "sdk ok" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const sdk = createExtensionSDK(
        "reasoning-test-ext",
        undefined,
        undefined,
        {
          apiKey: "sk-key",
          fetchFn: mockFetch,
        },
      );

      await sdk.queryLLM("Query test");
      expect(interceptedBody.reasoning_effort).toBe("low");

      await sdk.llm.complete("Complete test");
      expect(interceptedBody.reasoning_effort).toBe("low");
    });

    it("respects explicit reasoningEffort and reasoning_effort query overrides", async () => {
      let interceptedBody: any = null;
      const mockFetch: FetchFn = async (_url, init) => {
        interceptedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      // camelCase override
      await queryLLM("Test medium", {
        fetchFn: mockFetch,
        reasoningEffort: "medium",
      });
      expect(interceptedBody.reasoning_effort).toBe("medium");

      // snake_case override
      await queryLLM("Test high", {
        fetchFn: mockFetch,
        reasoning_effort: "high",
      });
      expect(interceptedBody.reasoning_effort).toBe("high");
    });

    it("omits reasoning_effort when explicitly set to null", async () => {
      let interceptedBody: any = null;
      const mockFetch: FetchFn = async (_url, init) => {
        interceptedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      await queryLLM("Test disabled", {
        fetchFn: mockFetch,
        reasoningEffort: null,
      });
      expect("reasoning_effort" in interceptedBody).toBe(false);

      await queryLLM("Test disabled snake", {
        fetchFn: mockFetch,
        reasoning_effort: null,
      });
      expect("reasoning_effort" in interceptedBody).toBe(false);
    });

    it("respects OPENAI_REASONING_EFFORT environment variable default", async () => {
      process.env.OPENAI_REASONING_EFFORT = "minimal";
      let interceptedBody: any = null;
      const mockFetch: FetchFn = async (_url, init) => {
        interceptedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      await queryLLM("Test env", {
        fetchFn: mockFetch,
      });
      expect(interceptedBody.reasoning_effort).toBe("minimal");
    });

    it("allows LLMClient to override default reasoning effort and merge per-query", async () => {
      let interceptedBody: any = null;
      const mockFetch: FetchFn = async (_url, init) => {
        interceptedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const client = new LLMClient({
        fetchFn: mockFetch,
        apiKey: "key",
        reasoning_effort: "high",
      });

      await client.query("Default high");
      expect(interceptedBody.reasoning_effort).toBe("high");

      await client.query("Override low", { reasoningEffort: "low" });
      expect(interceptedBody.reasoning_effort).toBe("low");
    });
  });

  describe("Thinking Tokens & Reasoning Budget Configuration", () => {
    it("defaults max_thinking_tokens and thinking_budget to 512 in chat completions payload", async () => {
      let interceptedBody: any = null;
      const mockFetch: FetchFn = async (_url, init) => {
        interceptedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      await queryLLM("Thinking test", {
        fetchFn: mockFetch,
        apiKey: "sk-key",
      });

      expect(interceptedBody.max_thinking_tokens).toBe(512);
      expect(interceptedBody.thinking_budget).toBe(512);
    });

    it("defaults max_thinking_tokens to 512 at SDK level via sdk.queryLLM and sdk.llm.complete", async () => {
      let interceptedBody: any = null;
      const mockFetch: FetchFn = async (_url, init) => {
        interceptedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "sdk ok" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const sdk = createExtensionSDK(
        "thinking-test-ext",
        undefined,
        undefined,
        {
          apiKey: "sk-key",
          fetchFn: mockFetch,
        },
      );

      await sdk.queryLLM("Query test");
      expect(interceptedBody.max_thinking_tokens).toBe(512);

      await sdk.llm.complete("Complete test");
      expect(interceptedBody.max_thinking_tokens).toBe(512);
    });

    it("respects explicit maxThinkingTokens, max_thinking_tokens, and thinkingBudget query overrides", async () => {
      let interceptedBody: any = null;
      const mockFetch: FetchFn = async (_url, init) => {
        interceptedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      // camelCase
      await queryLLM("Test 256", {
        fetchFn: mockFetch,
        maxThinkingTokens: 256,
      });
      expect(interceptedBody.max_thinking_tokens).toBe(256);
      expect(interceptedBody.thinking_budget).toBe(256);

      // snake_case
      await queryLLM("Test 1024", {
        fetchFn: mockFetch,
        max_thinking_tokens: 1024,
      });
      expect(interceptedBody.max_thinking_tokens).toBe(1024);

      // thinkingBudget
      await queryLLM("Test budget", {
        fetchFn: mockFetch,
        thinkingBudget: 128,
      });
      expect(interceptedBody.max_thinking_tokens).toBe(128);
    });

    it("omits max_thinking_tokens and thinking_budget when explicitly set to null", async () => {
      let interceptedBody: any = null;
      const mockFetch: FetchFn = async (_url, init) => {
        interceptedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      await queryLLM("Test disabled", {
        fetchFn: mockFetch,
        maxThinkingTokens: null,
      });
      expect("max_thinking_tokens" in interceptedBody).toBe(false);
      expect("thinking_budget" in interceptedBody).toBe(false);
    });

    it("respects OPENAI_MAX_THINKING_TOKENS environment variable default", async () => {
      process.env.OPENAI_MAX_THINKING_TOKENS = "768";
      let interceptedBody: any = null;
      const mockFetch: FetchFn = async (_url, init) => {
        interceptedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      await queryLLM("Test env", {
        fetchFn: mockFetch,
      });
      expect(interceptedBody.max_thinking_tokens).toBe(768);
    });

    it("extracts reasoningContent in detailed response and handles reasoning-only responses", async () => {
      const mockFetch: FetchFn = async () => {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Final answer",
                  reasoning_content: "Step 1, Step 2",
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const detailed = await queryLLM("Reasoning test", {
        fetchFn: mockFetch,
        detailed: true,
      });

      expect(detailed.content).toBe("Final answer");
      expect(detailed.reasoningContent).toBe("Step 1, Step 2");

      // Test fallback when content is empty but reasoning_content exists
      const mockReasoningOnlyFetch: FetchFn = async () => {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                  reasoning_content:
                    "Only thoughts generated before token limit",
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const contentFallback = await queryLLM("Fallback test", {
        fetchFn: mockReasoningOnlyFetch,
      });
      expect(contentFallback).toBe(
        "Only thoughts generated before token limit",
      );
    });
  });
});
