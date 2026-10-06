import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { getRootSetting, readRootSettings } from "../lib/settings";
import { LLMClient } from "../sdk/llm";
import { EmbedderClient } from "../sdk/embed";
import { SettingsManager } from "../sdk/settings";
import { batchTransport } from "./fixtures/batch-api";
import { discoverSettingsTargets, discoverExtensions, getSettingValue, setSettingValue,
  resetSettingValue, saveSettings } from "../scripts/settings";

const originalEnv = { ...process.env };
const project = resolve(import.meta.dir, "..");
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "shale-root-settings-"));
  mkdirSync(join(directory, "extensions"));
  writeFileSync(join(directory, "package.json"), '{"name":"root-settings-test"}');
  writeFileSync(join(directory, "settings.json"), "{}\n");
  writeFileSync(join(directory, "settings.help.json"), readFileSync(join(project, "settings.help.json")));
  process.env = { ...originalEnv, SHALE_SETTINGS_PATH: join(directory, "settings.json") };
  for (const key of Object.keys(process.env))
    if (/^(OPENAI_|EMBEDDING_|MODEL_BATCH_)/.test(key)) delete process.env[key];
});
afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(directory, { recursive: true, force: true });
});

it("discovers root as a settings target without treating it as an extension", () => {
  expect(discoverExtensions(directory)).toEqual([]);
  expect(discoverSettingsTargets(directory).map(target => target.name)).toEqual(["root"]);
  setSettingValue("root", "OPENAI_CHAT_MODEL", "local-chat", directory);
  expect(getSettingValue("root", "OPENAI_CHAT_MODEL", directory)).toBe("local-chat");
  expect(getRootSetting("OPENAI_CHAT_MODEL")).toBe("local-chat");
  resetSettingValue("root", "OPENAI_CHAT_MODEL", directory);
  expect(getRootSetting("OPENAI_CHAT_MODEL")).toBe("gpt-4o-mini");
});

it("hot-reloads model settings, keeps explicit overrides, and reads API keys from the environment", async () => {
  process.env.OPENAI_CHAT_MODEL = "legacy-chat";
  process.env.OPENAI_API_KEY = "test-secret";
  saveSettings("root", { OPENAI_BASE_URL: "https://models.invalid/v1", OPENAI_CHAT_MODEL: "file-chat",
    OPENAI_MAX_THINKING_TOKENS: 128 }, directory);
  const calls: Array<{ url: string; model: string; budget: number; authorization: string | null }> = [];
  const client = new LLMClient({ fetchFn: async (url: unknown, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), model: body.model, budget: body.max_thinking_tokens,
      authorization: new Headers(init.headers).get("authorization") });
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  } });
  expect(client.client.baseURL).toBe("https://models.invalid/v1");
  await client.query("first");
  setSettingValue("root", "OPENAI_CHAT_MODEL", "updated-chat", directory);
  setSettingValue("root", "OPENAI_CHAT_ENDPOINT", "https://other.invalid/chat/completions", directory);
  await client.query("second");
  await client.query("third", { model: "per-call", baseUrl: "https://override.invalid/v1" });
  expect(calls.map(call => call.model)).toEqual(["file-chat", "updated-chat", "per-call"]);
  expect(calls.map(call => call.url)).toEqual(["https://models.invalid/v1/chat/completions",
    "https://other.invalid/chat/completions", "https://override.invalid/v1/chat/completions"]);
  expect(calls.every(call => call.budget === 128 && call.authorization === "Bearer test-secret")).toBe(true);
  setSettingValue("root", "OPENAI_BASE_URL", "https://changed.invalid/v1", directory);
  expect(client.client.baseURL).toBe("https://changed.invalid/v1");
  expect(readRootSettings()).not.toHaveProperty("OPENAI_API_KEY");
});

it("applies root embedding model, storage size, and batch limits without recreating clients", async () => {
  saveSettings("root", { EMBEDDING_ENDPOINT: "https://embeddings.invalid/v1/embeddings",
    OPENAI_EMBEDDING_MODEL: "file-embedding", EMBEDDING_DIMENSIONS: 4, EMBEDDING_BATCH_SIZE: 2 }, directory);
  const sizes: number[] = [];
  const models: string[] = [];
  const client = new EmbedderClient({ fetchFn: async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body);
    sizes.push(body.input.length);
    models.push(body.model);
    return Response.json({ data: body.input.map((_: string, index: number) => ({ index, embedding: [1, 2] })) });
  } });
  const vectors = await client.embedBatch(["a", "b", "c"]);
  expect(vectors.map(vector => vector.length)).toEqual([4, 4, 4]);
  setSettingValue("root", "EMBEDDING_BATCH_SIZE", 1, directory);
  await client.embedBatch(["d", "e"]);
  expect(sizes).toEqual([2, 1, 1, 1]);
  expect(models.every(model => model === "file-embedding")).toBe(true);
});

it("reads dedicated Batch API mode and endpoint from root settings", async () => {
  saveSettings("root", { OPENAI_CHAT_BATCH_MODE: "api", OPENAI_CHAT_BATCH_ENDPOINT: "https://batch.invalid/v1/batches",
    MODEL_BATCH_POLL_INTERVAL_MS: 1 }, directory);
  const transport = batchTransport();
  const client = new LLMClient({ fetchFn: transport.fetchFn });
  expect(await client.queryBatch(["one", "two"])).toEqual(["one", "two"]);
  expect(transport.submissions).toHaveLength(1);
  expect(transport.submissions[0].url).toBe("https://batch.invalid/v1/batches");
});

it("validates root edits, rejects secrets and unknown keys, and resets optional values", () => {
  expect(() => setSettingValue("root", "OPENAI_API_KEY", "secret", directory)).toThrow("API keys belong in .env");
  expect(() => saveSettings("root", { EMBEDDING_API_KEY: "secret" }, directory)).toThrow("API keys belong in .env");
  expect(() => setSettingValue("root", "unknown", "value", directory)).toThrow("Unknown root setting");
  expect(() => setSettingValue("root", "OPENAI_CHAT_CONCURRENCY", "1.5", directory)).toThrow("safe integer");
  expect(() => setSettingValue("root", "OPENAI_CHAT_CONCURRENCY", 0, directory)).toThrow("minimum");
  expect(() => setSettingValue("root", "OPENAI_CHAT_CONCURRENCY", true, directory)).toThrow("Expected number");
  expect(() => setSettingValue("root", "OPENAI_CHAT_BATCH_MODE", "invalid", directory)).toThrow("allowed values");
  expect(() => setSettingValue("root", "OPENAI_BASE_URL", "file:///tmp", directory)).toThrow("HTTP or HTTPS");
  setSettingValue("root", "MODEL_TIMEOUT_MS", 6000, directory);
  resetSettingValue("root", "MODEL_TIMEOUT_MS", directory);
  expect(getSettingValue("root", "MODEL_TIMEOUT_MS", directory)).toBeUndefined();
  expect(() => getSettingValue("../root", undefined, directory)).toThrow("Settings target");
});

it("fails clearly on malformed root settings and excludes host settings from extension fallback", () => {
  writeFileSync(join(directory, "settings.json"), "[]");
  expect(() => readRootSettings()).toThrow("JSON object");
  writeFileSync(join(directory, "settings.json"), '{"OPENAI_API_KEY":"dummy"}');
  expect(() => readRootSettings()).toThrow("API keys belong in .env");
  writeFileSync(join(directory, "settings.json"), '{"OPENAI_CHAT_MODEL":"host"}');
  const previous = process.cwd();
  try {
    process.chdir(directory);
    expect(new SettingsManager().getAll<Record<string, unknown>>()).toEqual({});
  } finally { process.chdir(previous); }
});

it("supports standalone CLI get, set, list-targets, and reset for root", () => {
  const command = (...args: string[]) => spawnSync("bun", [join(project, "scripts/settings.ts"), ...args], {
    cwd: directory, env: process.env, encoding: "utf8",
  });
  expect(command("set", "root", "OPENAI_CHAT_CONCURRENCY", "6").status).toBe(0);
  expect(command("get", "root", "OPENAI_CHAT_CONCURRENCY").stdout.trim()).toBe("6");
  expect(command("list-targets").stdout).toContain("root:");
  expect(command("reset", "root", "OPENAI_CHAT_CONCURRENCY").status).toBe(0);
  expect(command("get", "root", "OPENAI_CHAT_CONCURRENCY").stdout.trim()).toBe("4");
  expect(command("set", "root", "OPENAI_API_KEY", "secret").status).toBe(1);
});
