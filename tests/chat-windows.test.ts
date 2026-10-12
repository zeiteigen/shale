import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ChatStore } from "../sdk/chat/store";
import { pendingWindows } from "../sdk/chat/windows";
import { transcriptChunks } from "../sdk/chat/transcript";
import { prepareSourceMemory } from "../lib/memory/prepare";
import type { ChatConversation, ChatMessage } from "../sdk/chat/types";
import { createTestDatabase } from "./fixtures/database";

const T0 = Date.UTC(2026, 0, 5, 10, 0);
const MIN = 60_000;
const conversation: ChatConversation = { conversationId: "c1", title: "#general", kind: "channel", uri: "test://c1" };

let database: ReturnType<typeof createTestDatabase>;
let store: ChatStore;

function msg(id: string, minute: number, text = `message ${id}`, author = "a"): ChatMessage {
  return { messageId: id, authorId: author, authorName: author.toUpperCase(), sentAt: T0 + minute * MIN, text, attachments: [] };
}

function markAll(windows: ReturnType<typeof pendingWindows>) {
  for (const w of windows) store.markIndexed(w.windowId, w.conversation.conversationId, w.startTime, w.endTime, w.messageHash, `src:${w.windowId}`);
}

beforeEach(() => {
  database = createTestDatabase();
  store = new ChatStore(database, "test-ext", "testchat");
});
afterEach(() => database.close());

describe("chat windows", () => {
  it("splits on silence and seals the trailing window only once idle", () => {
    store.ingest(conversation, [msg("1", 0), msg("2", 5), msg("3", 100), msg("4", 102)]);
    const settings = { gapMinutes: 30, idleMinutes: 60 };
    const early = pendingWindows(store, "test", settings, T0 + 110 * MIN);
    expect(early.map(w => w.messages.map(m => m.messageId))).toEqual([["1", "2"]]);
    markAll(early);
    const later = pendingWindows(store, "test", settings, T0 + 200 * MIN);
    expect(later.map(w => w.messages.map(m => m.messageId))).toEqual([["3", "4"]]);
    markAll(later);
    expect(pendingWindows(store, "test", settings, T0 + 300 * MIN)).toEqual([]);
    expect(store.dirtyConversations()).toEqual([]);
  });

  it("cuts long bursts by message count", () => {
    store.ingest(conversation, Array.from({ length: 7 }, (_, i) => msg(String(i), i)));
    const windows = pendingWindows(store, "test", { maxWindowMessages: 3 });
    expect(windows.map(w => w.messages.length)).toEqual([3, 3, 1]);
  });

  it("keeps the window id when a sealed window grows, and changes its hash on edits", () => {
    store.ingest(conversation, [msg("1", 0), msg("2", 5)]);
    const [first] = pendingWindows(store, "test", {});
    markAll([first!]);
    store.ingest(conversation, [msg("3", 10)]);
    const [grown] = pendingWindows(store, "test", {});
    expect(grown!.windowId).toBe(first!.windowId);
    expect(grown!.messages).toHaveLength(3);
    markAll([grown!]);
    expect(store.ingest(conversation, [msg("3", 10)]).changed).toBe(0);
    store.ingest(conversation, [{ ...msg("2", 5, "edited text"), editedAt: T0 + 20 * MIN }]);
    const [edited] = pendingWindows(store, "test", {});
    expect(edited!.windowId).toBe(first!.windowId);
    expect(edited!.messageHash).not.toBe(grown!.messageHash);
  });

  it("skips near duplicates only across feeds", () => {
    store.ingest(conversation, [{ ...msg("export:1", 0, "hi") }]);
    const changed = store.ingest(conversation, [
      { ...msg("api:9", 0, "hi"), sentAt: T0 + 400 },
      { ...msg("export:2", 0, "hi"), sentAt: T0 + 500 },
    ], { nearDuplicateMs: 2000 }).changed;
    expect(changed).toBe(1);
  });

  it("reuses a conversation registered by another feed under the same match key", () => {
    store.ingest({ ...conversation, conversationId: "export:a", matchKey: "k" }, [msg("x", 0)]);
    const { conversationId } = store.ingest({ ...conversation, conversationId: "api:1", matchKey: "k" }, [msg("y", 1)]);
    expect(conversationId).toBe("export:a");
    expect(store.stats().conversations).toBe(1);
  });

  it("rescans all sealed windows on metadata changes while preserving their identities", () => {
    const messages = [msg("1", 0), msg("2", 100)];
    store.ingest(conversation, messages);
    const first = pendingWindows(store, "test", {});
    markAll(first);
    expect(pendingWindows(store, "test", {})).toEqual([]);
    expect(store.scanFrom("c1")).toBeGreaterThan(0);
    store.ingest({ ...conversation, title: "#renamed" }, messages);
    expect(store.scanFrom("c1")).toBe(0);
    const renamed = pendingWindows(store, "test", {});
    expect(renamed.map(w => w.windowId)).toEqual(first.map(w => w.windowId));
    expect(renamed.every((w, i) => w.messageHash !== first[i]!.messageHash)).toBe(true);
    markAll(renamed);
    expect(pendingWindows(store, "test", {})).toEqual([]);
    store.ingest({ ...conversation, title: "#renamed", matchKey: "feed-match" }, messages);
    expect(pendingWindows(store, "test", {})).toEqual([]);
  });
});

describe("chat transcripts", () => {
  it("packs lines into chunks that fit the source memory without loss", () => {
    const messages = Array.from({ length: 120 }, (_, i) => ({ ...msg(String(i), i, `line ${i} ${"word ".repeat(15)}`), conversationId: "c1" }));
    const chunks = transcriptChunks(messages);
    expect(chunks.every(c => c.text_content.length <= 1200)).toBe(true);
    const total = chunks.reduce((n, c) => n + c.text_content.length, 0);
    expect(total).toBeLessThanOrEqual(12000);
    const memory = prepareSourceMemory(chunks, { title: "t", summary: "s" });
    const kept = memory.snippets.map(s => s.text).join("\n");
    expect(kept).toContain("line 0 ");
    expect(kept).toContain("line 119 ");
    expect(kept).toContain("line 60 ");
  });

  it("renders replies, attachments, reactions, and omits system notices", () => {
    const base = { conversationId: "c1" };
    const lines = transcriptChunks([
      { ...base, ...msg("1", 0, "look at this"), attachments: [{ kind: "image", name: "cat.png" }], reactions: [{ emoji: "👍", count: 2 }] },
      { ...base, ...msg("2", 1, "nice", "b"), replyToId: "1" },
      { ...base, ...msg("3", 2, "pinned a message"), isSystem: true },
    ])[0]!.text_content;
    expect(lines).toContain("A: look at this [image: cat.png] {👍×2}");
    expect(lines).toContain("B (↪ A): nice");
    expect(lines).not.toContain("pinned");
  });
});
