import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveChatEndpoint, resolveEmbeddingEndpoint, resolveTimeout } from "../lib/ai/config";
import { LLMClient } from "../sdk/llm";
import { EmbedderClient } from "../sdk/embed";
import { loadSettings, loadSettingsHelp, saveSettings, setSettingValue } from "../lib/settings-editor";

const originalEnv = { ...process.env };
let directory: string;
function settings(values: Record<string, unknown>) { writeFileSync(join(directory, "settings.json"), JSON.stringify(values)); }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "shale-model-endpoints-"));
  process.env = { ...originalEnv, SHALE_SETTINGS_PATH: join(directory, "settings.json") };
  for (const key of Object.keys(process.env)) if (/^(OPENAI_|EMBEDDING_|CHAT_TIMEOUT_MS$|MODEL_TIMEOUT_MS$|MAX_THINKING_TOKENS$)/.test(key)) delete process.env[key];
  writeFileSync(join(directory, "settings.help.json"), readFileSync(join(import.meta.dir, "../settings.help.json")));
  settings({ OPENAI_BASE_URL: "http://127.0.0.1:8080/v1" });
});
afterEach(() => { process.env = { ...originalEnv }; rmSync(directory, { recursive: true, force: true }); });

it("derives chat and embedding paths from only the shared base and sends the embedding POST there", async () => {
  expect(resolveChatEndpoint()).toBe("http://127.0.0.1:8080/v1/chat/completions");
  expect(resolveEmbeddingEndpoint()).toBe("http://127.0.0.1:8080/v1/embeddings");
  const urls: string[] = [];
  const client = new EmbedderClient({ padToDimensions: 2, fetchFn: async (url: unknown, init: any) => {
    urls.push(String(url));
    expect(init?.method).toBe("POST");
    return Response.json({ data: [{ index: 0, embedding: [1, 2] }] });
  } });
  await client.embed("first");
  settings({ OPENAI_BASE_URL: "http://127.0.0.1:8080/v1/" });
  await client.embed("second");
  expect(urls).toEqual(["http://127.0.0.1:8080/v1/embeddings", "http://127.0.0.1:8080/v1/embeddings"]);
});

it("does not let the removed shared endpoint override a canonical base URL", () => {
  process.env.OPENAI_ENDPOINT = "http://127.0.0.1:8080/v1";
  settings({ OPENAI_BASE_URL: "http://127.0.0.1:8080/v1", OPENAI_ENDPOINT: "http://127.0.0.1:8080/v1" });
  expect(resolveEmbeddingEndpoint()).toBe("http://127.0.0.1:8080/v1/embeddings");
  expect(resolveChatEndpoint()).toBe("http://127.0.0.1:8080/v1/chat/completions");
});

it("preserves query parameters when appending paths and honors role overrides and per-call URLs", () => {
  settings({ OPENAI_BASE_URL: "https://shared.invalid/v1/?api-version=test", EMBEDDING_BASE_URL: "http://embedding.invalid/v1/" });
  expect(resolveChatEndpoint()).toBe("https://shared.invalid/v1/chat/completions?api-version=test");
  expect(resolveEmbeddingEndpoint()).toBe("http://embedding.invalid/v1/embeddings");
  settings({ OPENAI_BASE_URL: "https://shared.invalid/v1", EMBEDDING_ENDPOINT: "https://embedding.invalid/custom/embeddings?version=test" });
  expect(resolveEmbeddingEndpoint()).toBe("https://embedding.invalid/custom/embeddings?version=test");
  expect(resolveEmbeddingEndpoint({ baseUrl: "https://explicit.invalid/v1" })).toBe("https://explicit.invalid/v1/embeddings");
});

it("rejects a bare base in a full-endpoint setting before sending or saving a request", async () => {
  settings({ EMBEDDING_ENDPOINT: "http://127.0.0.1:8080/v1" });
  const client = new EmbedderClient({ fetchFn: async () => { throw new Error("Should not send a request"); } });
  await expect(client.embed("first")).rejects.toThrow("EMBEDDING_ENDPOINT must be a full request URL");
  expect(() => setSettingValue("root", "EMBEDDING_ENDPOINT", "http://127.0.0.1:8080/v1", directory)).toThrow("full request URL");
  expect(() => setSettingValue("root", "OPENAI_CHAT_ENDPOINT", "http://127.0.0.1:8080/v1/", directory)).toThrow("full request URL");
});

it("removes aliases from the editor and persisted files while keeping canonical model controls", async () => {
  process.env.OPENAI_MODEL = "old-chat";
  process.env.EMBEDDING_MODEL = "old-embedding";
  process.env.OPENAI_TIMEOUT_MS = "1";
  process.env.OPENAI_CHAT_TIMEOUT_MS = "1";
  process.env.OPENAI_EMBEDDING_TIMEOUT_MS = "1";
  process.env.MAX_THINKING_TOKENS = "1";
  process.env.OPENAI_THINKING_BUDGET = "1";
  const aliases = { OPENAI_ENDPOINT: "http://127.0.0.1:8080/v1", OPENAI_MODEL: "old-chat", EMBEDDING_MODEL: "old-embedding",
    OPENAI_CHAT_TIMEOUT_MS: 1, OPENAI_EMBEDDING_TIMEOUT_MS: 1, OPENAI_TIMEOUT_MS: 1,
    MAX_THINKING_TOKENS: 1, OPENAI_THINKING_BUDGET: 1, VISUALIZER_PORT: 3333 };
  settings({ ...aliases, OPENAI_BASE_URL: "http://127.0.0.1:8080/v1" });
  expect(loadSettings("root", directory)).toEqual({ OPENAI_BASE_URL: "http://127.0.0.1:8080/v1" });
  const schema = loadSettingsHelp("root", directory)!.settings;
  for (const key of Object.keys(aliases)) {
    expect(schema).not.toHaveProperty(key);
    expect(() => setSettingValue("root", key, "value", directory)).toThrow("Unknown root setting");
  }
  expect(resolveTimeout(undefined, "embedding")).toBe(300_000);
  const bodies: any[] = [];
  const fetchFn = async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body); bodies.push(body);
    return Response.json(body.input ? { data: [{ index: 0, embedding: [1, 2] }] } : { choices: [{ message: { content: "ok" } }] });
  };
  await new LLMClient({ fetchFn }).query("hello");
  await new EmbedderClient({ fetchFn, padToDimensions: 2 }).embed("hello");
  expect(bodies[0].model).toBe("gpt-4o-mini");
  expect(bodies[0].max_thinking_tokens).toBe(512);
  expect(bodies[1].model).toBe("text-embedding-3-small");
  saveSettings("root", { ...aliases, OPENAI_CHAT_MODEL: "canonical" }, directory);
  expect(JSON.parse(readFileSync(join(directory, "settings.json"), "utf8"))).toEqual({ OPENAI_CHAT_MODEL: "canonical" });
});
