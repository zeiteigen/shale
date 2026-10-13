import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionSDK, createMessageBus, type ShaleSDK } from "../sdk";
import { isTExtensionManifest } from "../lib/extension";
import { DEFAULT_POLICY } from "../lib/access/policy";
import manifest from "../extensions/ai-chats/manifest.json";
import {
  AI_CHATS_PROTOCOL_VERSION, snapshotRecords, validateAiChatBatch, type AiChatSnapshot, type NormalizedConversation,
} from "../extensions/ai-chats/contract";
import { normalizeChatGpt } from "../extensions/ai-chats/normalize/chatgpt";
import { normalizeClaude } from "../extensions/ai-chats/normalize/claude";
import { accept, inspect } from "../extensions/ai-chats/subscribe";
import { assignTimes } from "../extensions/ai-chats/ingest";
import { run as index } from "../extensions/ai-chats/index";
import { setup as setupRefresh } from "../extensions/ai-chats/refresh";
import { createTestDatabase } from "./fixtures/database";

const T0 = Date.UTC(2026, 0, 5, 10, 0);
const at = (minute: number) => T0 + minute * 60_000;
const seconds = (minute: number) => at(minute) / 1000;

let directory: string;
let database: ReturnType<typeof createTestDatabase>;
let sdk: ShaleSDK;

function configure(settings: Record<string, unknown> = {}) {
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ namespace: "ai-chats", idleMinutes: 0, ...settings }));
}

const count = (sql: string) => database.query<{ n: number }, []>(`SELECT count(*) AS n FROM (${sql})`).get()!.n;
const allText = () => database.query<{ t: string }, []>("SELECT group_concat(text_content,'\n') AS t FROM chunks").get()!.t ?? "";

let batches = 0;
async function send(records: AiChatSnapshot[], collectorId = "collector-1") {
  const content = JSON.stringify({ type: "ai_chat_batch", protocolVersion: AI_CHATS_PROTOCOL_VERSION, collectorId,
    batchId: `batch-${++batches}`, records });
  return accept({ target_processor: "ai-chats", content, metadata: { connector: "chrome-extension", data_origin: "chrome" } }, sdk);
}

function conversation(overrides: Partial<NormalizedConversation> = {}): NormalizedConversation {
  return {
    provider: "chatgpt", conversationId: "conv-1", title: "Rust lifetimes", url: "https://chatgpt.com/c/conv-1",
    updatedAt: at(3), pathIds: ["u1", "a1"],
    messages: [
      { id: "u1", role: "user", sentAt: at(0), text: "Why does the borrow checker reject this?", attachments: [] },
      { id: "a1", role: "assistant", sentAt: at(1), text: "Because the reference outlives the vector.", attachments: [] },
    ],
    ...overrides,
  };
}

/** A ChatGPT tree with an edited first prompt: the abandoned branch must not be indexed. */
const chatgptTree = {
  id: "conv-1", title: "Rust lifetimes", create_time: seconds(0), update_time: seconds(5), current_node: "a2",
  mapping: {
    root: { id: "root", parent: null, children: ["sys"] },
    sys: { id: "sys", parent: "root", children: ["u-old", "u1"], message: { id: "sys", author: { role: "system" },
      content: { content_type: "text", parts: [""] }, metadata: { is_visually_hidden_from_conversation: true } } },
    "u-old": { id: "u-old", parent: "sys", children: ["a-old"], message: { id: "u-old", author: { role: "user" },
      create_time: seconds(0), recipient: "all", content: { content_type: "text", parts: ["old prompt"] } } },
    "a-old": { id: "a-old", parent: "u-old", children: [], message: { id: "a-old", author: { role: "assistant" },
      create_time: seconds(1), recipient: "all", content: { content_type: "text", parts: ["abandoned answer"] } } },
    u1: { id: "u1", parent: "sys", children: ["ctx"], message: { id: "u1", author: { role: "user" }, create_time: seconds(2),
      recipient: "all", content: { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://x" }, "What is in this diagram?"] },
      metadata: { attachments: [{ name: "notes.pdf", mime_type: "application/pdf" }] } } },
    ctx: { id: "ctx", parent: "u1", children: ["think"], message: { id: "ctx", author: { role: "assistant" }, create_time: seconds(2),
      recipient: "python", content: { content_type: "code", text: "print(1)" } } },
    think: { id: "think", parent: "ctx", children: ["a2"], message: { id: "think", author: { role: "assistant" }, create_time: seconds(3),
      recipient: "all", content: { content_type: "thoughts", thoughts: [] } } },
    a2: { id: "a2", parent: "think", children: [], message: { id: "a2", author: { role: "assistant" }, create_time: seconds(4),
      recipient: "all", content: { content_type: "text", parts: ["A sequence diagram citeturn0search1of the login flow."] } } },
  },
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "shale-ai-chats-"));
  database = createTestDatabase();
  sdk = createExtensionSDK("ai-chats", { database, messageBus: createMessageBus(), extensionDir: directory });
  sdk.logger.log = () => {};
  sdk.logger.warn = () => {};
  sdk.logger.error = () => {};
  sdk.queryLLM = (async () => JSON.stringify({ title: "Borrow checker help", summary: "Asked why a reference outlives a vector.", topics: ["rust"] })) as unknown as typeof sdk.queryLLM;
  configure();
});

afterEach(() => {
  sdk.messages.clear();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("ai-chats extension", () => {
  it("has an auto-discoverable manifest with a Chrome module and private origins", () => {
    expect(isTExtensionManifest(manifest)).toBe(true);
    expect(manifest.chrome_module.background).toBe("chrome/background.ts");
    expect(isTExtensionManifest({ ...manifest, chrome_module: { background: "x.ts", inject: { "Bad Name": "y.ts" } } })).toBe(false);
    expect(DEFAULT_POLICY.originTiers).toMatchObject({ chatgpt: "private", claude: "private", gemini: "private" });
  });

  it("normalizes the active ChatGPT branch without hidden, tool, or reasoning messages", () => {
    const result = normalizeChatGpt(chatgptTree);
    expect(result.messages.map(m => m.id)).toEqual(["u1", "a2"]);
    expect(result.pathIds).toEqual(["u1", "a2"]);
    expect(result.messages[0]).toMatchObject({ role: "user", text: "What is in this diagram?", sentAt: at(2),
      attachments: [{ kind: "image", name: "image" }, { kind: "file", name: "notes.pdf" }] });
    expect(result.messages[1]!.text).toBe("A sequence diagram of the login flow.");
    expect(result).toMatchObject({ conversationId: "conv-1", url: "https://chatgpt.com/c/conv-1", createdAt: at(0), updatedAt: at(5) });
  });

  it("normalizes the current Claude branch, skipping thinking and filling missing times", () => {
    const result = normalizeClaude({
      uuid: "c-1", name: "", updated_at: new Date(at(9)).toISOString(), current_leaf_message_uuid: "m4",
      chat_messages: [
        { uuid: "m1", sender: "human", text: "Plan a trip", created_at: new Date(at(0)).toISOString(), parent_message_uuid: "00000000-0000-4000-8000-000000000000",
          files: [{ file_name: "map.png", file_kind: "image" }] },
        { uuid: "m2", sender: "assistant", created_at: new Date(at(1)).toISOString(), parent_message_uuid: "m1",
          content: [{ type: "thinking", text: "hidden reasoning" }, { type: "text", text: "Old answer" }] },
        { uuid: "m3", sender: "assistant", parent_message_uuid: "m1",
          content: [{ type: "thinking", text: "hidden reasoning" }, { type: "tool_use" }, { type: "text", text: "Go to Lisbon." }] },
        { uuid: "m4", sender: "human", text: "Thanks", created_at: new Date(at(2)).toISOString(), parent_message_uuid: "m3" },
      ],
    });
    expect(result.title).toBe("Untitled chat");
    expect(result.messages.map(m => [m.id, m.text])).toEqual([["m1", "Plan a trip"], ["m3", "Go to Lisbon."], ["m4", "Thanks"]]);
    expect(result.messages[0]!.attachments).toEqual([{ kind: "image", name: "map.png" }]);
    expect(result.messages[1]!.sentAt).toBe(at(0) + 1);
    expect(JSON.stringify(result)).not.toContain("hidden reasoning");
  });

  it("validates the wire contract and splits large conversations into stable parts", async () => {
    const [record] = await snapshotRecords(conversation(), { captureMethod: "api", revision: at(3) });
    const batch = (records: unknown[]) => ({ type: "ai_chat_batch", protocolVersion: 1, collectorId: "c", batchId: "b", records });
    expect(() => validateAiChatBatch(batch([record]))).not.toThrow();
    expect(() => validateAiChatBatch(batch([{ ...record, url: "https://evil.example/c/conv-1" }]))).toThrow(/url/);
    expect(() => validateAiChatBatch(batch([{ ...record, provider: "bard" }]))).toThrow(/provider/);
    expect(() => validateAiChatBatch({ ...batch([record]), protocolVersion: 2 })).toThrow(/version/);
    expect(() => validateAiChatBatch(batch([{ ...record, messages: [...record!.messages, record!.messages[0]] }]))).toThrow(/messages/);
    // Unchanged content hashes to the same record id, so re-captures are duplicates.
    expect((await snapshotRecords(conversation(), { captureMethod: "api", revision: at(3) }))[0]!.recordId).toBe(record!.recordId);
    const long = conversation({ messages: Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`, role: i % 2 ? "assistant" as const : "user" as const, sentAt: at(i), text: "x".repeat(3000), attachments: [] })) });
    const parts = await snapshotRecords(long, { captureMethod: "api", revision: 1, maxBytes: 8000 });
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.parts === parts.length && part.pathIds === long.pathIds)).toBe(true);
    expect(parts.flatMap(part => part.messages).map(m => m.id)).toEqual(long.messages.map(m => m.id));
    const huge = await snapshotRecords(conversation({ messages: [{ id: "big", role: "assistant", text: "y".repeat(300_000), attachments: [] }] }),
      { captureMethod: "api", revision: 1 });
    expect(huge[0]!.messages[0]!.text).toContain("[truncated");
    expect(() => validateAiChatBatch(batch(huge))).not.toThrow();
  });

  it("admits snapshots durably with duplicate and conflict receipts", async () => {
    const records = await snapshotRecords(conversation(), { captureMethod: "api", revision: at(3) });
    const first = await send(records);
    expect(first.records).toEqual([expect.objectContaining({ recordId: records[0]!.recordId, status: "received" })]);
    expect(count("SELECT 1 FROM ai_chatgpt_messages")).toBe(2);
    const again = await send(records);
    expect(again.records[0]).toMatchObject({ status: "duplicate", jobId: first.records[0]!.jobId });
    await expect(send([{ ...records[0]!, title: "Changed" }])).rejects.toMatchObject({ status: 409 });
    const status = await inspect(new Request(`http://local/connectors/ai-chats/status?ids=${first.records[0]!.jobId}`), sdk);
    expect(await status.json()).toMatchObject({ records: [{ jobId: first.records[0]!.jobId, status: "indexed" }] });
    const policy = await (await inspect(new Request("http://local/connectors/ai-chats/policy"), sdk)).json();
    expect(policy).toMatchObject({ protocolVersion: 1, providers: ["chatgpt", "claude", "gemini"], fetchDelayMs: 1500 });
  });

  it("indexes conversations as chat sessions with the user and assistant as participants", async () => {
    await send(await snapshotRecords(conversation(), { captureMethod: "api", revision: at(3) }));
    const result = await index(sdk);
    expect(result!.indexed).toBe(1);
    expect(count("SELECT 1 FROM sources WHERE origin='chatgpt' AND type='chat_session' AND uri LIKE 'chatgpt://conversation/conv-1#window=%'")).toBe(1);
    expect(allText()).toContain("Me: Why does the borrow checker reject this?");
    expect(allText()).toContain("ChatGPT: Because the reference outlives the vector.");
    expect(count("SELECT 1 FROM entities WHERE type='Person'")).toBe(1);
    expect(count("SELECT 1 FROM entities WHERE type='Bot'")).toBe(1);
  });

  it("drops an abandoned branch after an edit and ignores older revisions", async () => {
    await send(await snapshotRecords(conversation(), { captureMethod: "api", revision: at(3) }));
    await index(sdk);
    expect(allText()).toContain("reference outlives the vector");
    const edited = conversation({ updatedAt: at(10), pathIds: ["u1", "a1b"], messages: [
      conversation().messages[0]!,
      { id: "a1b", role: "assistant", sentAt: at(2), text: "Regenerated: the vector is dropped first.", attachments: [] },
    ] });
    await send(await snapshotRecords(edited, { captureMethod: "api", revision: at(10) }));
    expect(count("SELECT 1 FROM ai_chatgpt_messages")).toBe(2);
    expect(count("SELECT 1 FROM sources WHERE origin='chatgpt'")).toBe(0);
    await index(sdk);
    expect(allText()).toContain("Regenerated: the vector is dropped first.");
    expect(allText()).not.toContain("reference outlives the vector");
    // A delayed capture of the old revision cannot bring the abandoned branch back.
    const stale = await send(await snapshotRecords(conversation({ title: "Stale" }), { captureMethod: "api", revision: at(3) }));
    expect(stale.records[0]).toMatchObject({ status: "skipped" });
    expect(count("SELECT 1 FROM ai_chatgpt_messages")).toBe(2);
  });

  it("applies multi-part snapshots in any order", async () => {
    const long = conversation({ pathIds: ["m0", "m1", "m2", "m3"], messages: Array.from({ length: 4 }, (_, i) => ({
      id: `m${i}`, role: i % 2 ? "assistant" as const : "user" as const, sentAt: at(i), text: `part ${i} ${"z".repeat(3000)}`, attachments: [] })) });
    const parts = await snapshotRecords(long, { captureMethod: "api", revision: at(5), maxBytes: 8000 });
    expect(parts.length).toBeGreaterThan(1);
    for (const part of [...parts].reverse()) await send([part]);
    expect(count("SELECT 1 FROM ai_chatgpt_messages")).toBe(4);
  });

  it("keeps first-seen times for Gemini page captures and never prunes them", async () => {
    const page = (texts: string[]) => ({ provider: "gemini" as const, conversationId: "g-1", title: "Gemini chat",
      url: "https://gemini.google.com/app/g-1",
      messages: texts.map((text, i) => ({ id: `t${i}:${i % 2 ? "assistant" : "user"}`, role: i % 2 ? "assistant" as const : "user" as const, text, attachments: [] })) });
    await send(await snapshotRecords(page(["hello", "hi there"]), { captureMethod: "dom", revision: 0 }));
    const firstTimes = database.query<{ sent_at: number }, []>("SELECT sent_at FROM ai_gemini_messages ORDER BY sent_at").all().map(r => r.sent_at);
    await Bun.sleep(5);
    await send(await snapshotRecords(page(["hello", "hi there", "tell me more", "sure"]), { captureMethod: "dom", revision: 0 }));
    const rows = database.query<{ message_id: string; sent_at: number }, []>("SELECT message_id,sent_at FROM ai_gemini_messages ORDER BY sent_at,message_id").all();
    expect(rows.map(r => r.message_id)).toEqual(["t0:user", "t1:assistant", "t2:user", "t3:assistant"]);
    expect(rows.slice(0, 2).map(r => r.sent_at)).toEqual(firstTimes);
    // A page that only rendered the latest turns removes nothing.
    await send(await snapshotRecords({ ...page([]), messages: page(["hello", "hi there", "tell me more", "sure"]).messages.slice(2) },
      { captureMethod: "dom", revision: 0 }));
    expect(count("SELECT 1 FROM ai_gemini_messages")).toBe(4);
  });

  it("orders untimed messages around known ones", () => {
    const m = (id: string, sentAt?: number) => ({ id, role: "user" as const, sentAt, text: id, attachments: [] });
    expect(assignTimes([m("a"), m("b", 100), m("c"), m("d", 100)], new Map(), 1000)).toEqual([99, 100, 101, 102]);
    expect(assignTimes([m("a"), m("b")], new Map([["a", 50]]), 1000)).toEqual([50, 1000]);
  });

  it("skips providers turned off in settings", async () => {
    configure({ providers: ["claude"] });
    const result = await send(await snapshotRecords(conversation(), { captureMethod: "api", revision: at(3) }));
    expect(result.records[0]).toMatchObject({ status: "skipped", reason: expect.stringContaining("turned off") });
    expect(count("SELECT 1 FROM sqlite_master WHERE name='ai_chatgpt_messages'")).toBe(0);
  });

  it("refreshes a window through the handler named after its origin", async () => {
    setupRefresh(sdk);
    await send(await snapshotRecords(conversation({ provider: "claude", url: "https://claude.ai/chat/conv-1" }),
      { captureMethod: "api", revision: at(3) }));
    await index(sdk);
    const source = database.query<{ id: string }, []>("SELECT id FROM sources WHERE origin='claude'").get()!;
    const response = await sdk.messages.request("source:refresh", { sourceId: source.id, actor: "test", reason: "refresh" },
      { target: "claude" });
    expect(response).toMatchObject({ sourceId: source.id, status: "refreshed" });
  });
});
