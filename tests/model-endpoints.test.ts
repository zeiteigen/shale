import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveChatEndpoint } from "../lib/ai/config";
import { LLMClient } from "../sdk/llm";
import { loadSettings, loadSettingsHelp, saveSettings, setSettingValue } from "../lib/settings-editor";

const originalEnv = { ...process.env };
let directory: string;
function settings(values: Record<string, unknown>) { writeFileSync(join(directory, "data/settings.json"), JSON.stringify(values)); }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "shale-model-endpoints-"));
  mkdirSync(join(directory, "data"));
  process.env = { ...originalEnv, SHALE_SETTINGS_PATH: join(directory, "data/settings.json") };
  for (const key of Object.keys(process.env)) if (/^(OPENAI_|CHAT_TIMEOUT_MS$|MODEL_TIMEOUT_MS$|MAX_THINKING_TOKENS$)/.test(key)) delete process.env[key];
  writeFileSync(join(directory, "data/settings.help.json"), readFileSync(join(import.meta.dir, "../data/settings.help.json")));
  settings({ OPENAI_BASE_URL: "http://127.0.0.1:8080/v1" });
});
afterEach(() => { process.env = { ...originalEnv }; rmSync(directory, { recursive: true, force: true }); });

it("derives chat completions from the shared base URL and reads settings on each request", async () => {
  expect(resolveChatEndpoint()).toBe("http://127.0.0.1:8080/v1/chat/completions");
  const urls: string[] = [];
  const client = new LLMClient({ fetchFn: async (url: unknown) => {
    urls.push(String(url));
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  } });
  await client.query("first");
  settings({ OPENAI_BASE_URL: "http://127.0.0.1:8080/v1/" });
  await client.query("second");
  expect(urls).toEqual(["http://127.0.0.1:8080/v1/chat/completions", "http://127.0.0.1:8080/v1/chat/completions"]);
});

it("preserves query parameters and honors explicit chat endpoint overrides", () => {
  settings({ OPENAI_BASE_URL: "https://shared.invalid/v1/?api-version=test" });
  expect(resolveChatEndpoint()).toBe("https://shared.invalid/v1/chat/completions?api-version=test");
  settings({ OPENAI_BASE_URL: "https://shared.invalid/v1", OPENAI_CHAT_ENDPOINT: "https://chat.invalid/custom?version=test" });
  expect(resolveChatEndpoint()).toBe("https://chat.invalid/custom?version=test");
});

it("removes aliases from the editor and persisted files while keeping canonical chat controls", async () => {
  process.env.OPENAI_MODEL = "old-chat";
  process.env.OPENAI_TIMEOUT_MS = "1";
  process.env.OPENAI_CHAT_TIMEOUT_MS = "1";
  process.env.MAX_THINKING_TOKENS = "1";
  process.env.OPENAI_THINKING_BUDGET = "1";
  const aliases = { OPENAI_ENDPOINT: "http://127.0.0.1:8080/v1", OPENAI_MODEL: "old-chat",
    OPENAI_CHAT_TIMEOUT_MS: 1, OPENAI_TIMEOUT_MS: 1, MAX_THINKING_TOKENS: 1,
    OPENAI_THINKING_BUDGET: 1, VISUALIZER_PORT: 3333 };
  settings({ ...aliases, OPENAI_BASE_URL: "http://127.0.0.1:8080/v1" });
  expect(loadSettings("root", directory)).toEqual({ OPENAI_BASE_URL: "http://127.0.0.1:8080/v1" });
  const schema = loadSettingsHelp("root", directory)!.settings;
  for (const key of Object.keys(aliases)) {
    expect(schema).not.toHaveProperty(key);
    expect(() => setSettingValue("root", key, "value", directory)).toThrow("Unknown root setting");
  }
  const bodies: any[] = [];
  const client = new LLMClient({ fetchFn: async (_url: unknown, init: any) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  } });
  await client.query("hello");
  expect(bodies[0].model).toBe("gpt-4o-mini");
  expect(bodies[0].max_thinking_tokens).toBe(512);
  saveSettings("root", { ...aliases, OPENAI_CHAT_MODEL: "canonical" }, directory);
  expect(JSON.parse(readFileSync(join(directory, "data/settings.json"), "utf8"))).toEqual({ OPENAI_CHAT_MODEL: "canonical" });
});
