import { afterEach, beforeEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { LLMClient } from "../sdk/llm";
import { createExtensionSDK } from "../sdk";
import { batchTransport } from "./fixtures/batch-api";
import { parseBatchOutput } from "../lib/ai/batch-output";

const originalEnv = { ...process.env };
beforeEach(() => {
  process.env = { ...originalEnv };
  for (const key of Object.keys(process.env))
    if (/^(OPENAI_|MODEL_BATCH_)/.test(key)) delete process.env[key];
});
afterEach(() => { process.env = { ...originalEnv }; });

it("uploads chat JSONL, submits one job, polls, and reorders detailed output", async () => {
  process.env.OPENAI_CHAT_ENDPOINT = "https://unused.invalid/v1/chat/completions";
  const transport = batchTransport();
  const client = new LLMClient({ batchMode: "api", batchEndpoint: "https://chat-batch.invalid/v1/batches?version=1",
    apiKey: "chat-key", fetchFn: transport.fetchFn, batchPollIntervalMs: 1 });
  const results = await client.queryBatch(["first", "second", "third"], { detailed: true });
  expect(results.map(result => result.content)).toEqual(["first", "second", "third"]);
  expect(transport.uploads[0].url).toBe("https://chat-batch.invalid/v1/files?version=1");
  expect(transport.uploads[0].lines.map(line => line.custom_id)).toEqual(["request-0", "request-1", "request-2"]);
  expect(transport.submissions).toHaveLength(1);
  expect(transport.submissions[0].body.endpoint).toBe("/v1/chat/completions");
  expect(transport.submissions[0].authorization).toBe("Bearer chat-key");
  expect(transport.retrievals).toHaveLength(1);
  expect(transport.retrievals[0]).toBe("https://chat-batch.invalid/v1/batches/batch-0?version=1");
});

it("uses chat batches for extension tasks across preparation and finalization", async () => {
  const transport = batchTransport();
  const db = new Database(":memory:");
  db.run("CREATE TABLE extension_state(extension_id TEXT,state_key TEXT,value TEXT,updated_at INTEGER,PRIMARY KEY(extension_id,state_key))");
  try {
    const sdk = createExtensionSDK("batch-extension", { database: db, models: {
      connection: { fetchFn: transport.fetchFn, batchMode: "api", batchPollIntervalMs: 1 },
      chat: { batchEndpoint: "https://chat-batch.invalid/v1/batches" },
    } });
    const output = await sdk.models.batch(
      () => sdk.models.mapChat(["1", "2", "3"], text => sdk.queryLLM(text)),
      async prepared => prepared,
    );
    expect(output).toEqual(["1", "2", "3"]);
    expect(transport.submissions.map(item => item.body.endpoint)).toEqual(["/v1/chat/completions"]);
    expect(transport.uploads[0].lines).toHaveLength(3);
    expect(sdk.state.getAll()).toHaveLength(0);
  } finally { db.close(); }
});

it("persists a timed-out job and resumes it without uploading or submitting again", async () => {
  const transport = batchTransport();
  const db = new Database(":memory:");
  db.run("CREATE TABLE extension_state(extension_id TEXT,state_key TEXT,value TEXT,updated_at INTEGER,PRIMARY KEY(extension_id,state_key))");
  try {
    const makeSDK = () => createExtensionSDK("resume-batch", { database: db, models: { chat: {
      fetchFn: transport.fetchFn, batchMode: "api", batchEndpoint: "https://batch.invalid/v1/batches", batchPollIntervalMs: 20,
    } } });
    const sdk = makeSDK();
    await expect(sdk.queryLLMBatch(["saved"], { batchTimeoutMs: 10 })).rejects.toThrow("batch-0");
    expect(sdk.state.getAll()).toHaveLength(1);
    const restarted = makeSDK();
    expect(await restarted.queryLLMBatch(["saved"], { batchTimeoutMs: 1000 })).toEqual(["saved"]);
    expect(transport.uploads).toHaveLength(1);
    expect(transport.submissions).toHaveLength(1);
    expect(restarted.state.getAll()).toHaveLength(0);
  } finally { db.close(); }
});

it("reports terminal batch failures and rejects incomplete or duplicate outputs", async () => {
  const transport = batchTransport();
  transport.controls.status = "failed";
  const client = new LLMClient({ batchMode: "api", fetchFn: transport.fetchFn, batchPollIntervalMs: 1 });
  await expect(client.queryBatch(["test"])).rejects.toThrow("batch-0 failed");
  expect(() => parseBatchOutput("", 1)).toThrow("exactly 1");
  const row = JSON.stringify({ custom_id: "request-0", response: { status_code: 200, body: {} } });
  expect(() => parseBatchOutput(`${row}\n${row}`, 2)).toThrow("duplicate request IDs");
  expect(() => parseBatchOutput(JSON.stringify({ custom_id: "request-0", error: { message: "bad request" } }), 1)).toThrow("bad request");
});

it("returns empty batches without transport calls and honors cancellation", async () => {
  const transport = batchTransport();
  const client = new LLMClient({ batchMode: "api", fetchFn: transport.fetchFn });
  expect(await client.queryBatch([])).toEqual([]);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(client.queryBatch(["cancel"], { signal: controller.signal })).rejects.toThrow("cancelled");
  expect(transport.uploads).toHaveLength(0);
});
