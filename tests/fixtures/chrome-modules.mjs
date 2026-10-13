/**
 * Chrome extension module system: claims, per-module validation and delivery routing, job
 * dispatch, background message routing, and the ai-chats sync job against a fake ChatGPT.
 */
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
globalThis.indexedDB = indexedDB;

const SERVER = "http://127.0.0.1:7425/ingest";
const local = {
    serverUrl: SERVER,
    capturePolicies: {
      [SERVER]: {
        modules: {
          "ai-chats": {
            protocolVersion: 1,
            providers: ["chatgpt", "claude", "gemini"],
            autoSyncMinutes: 0,
            fetchDelayMs: 1,
            maxConversationsPerSync: 100,
          },
        },
      },
    },
  },
  session = {};
const storage = (data) => ({
  get: async (keys) =>
    keys === null
      ? { ...data }
      : Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys])
            .filter((k) => data[k] !== undefined)
            .map((k) => [k, data[k]]),
        ),
  set: async (values) => Object.assign(data, values),
  remove: async (key) => {
    delete data[key];
  },
});
const listeners = {};
const event = (name) => ({
  addListener: (fn) => {
    listeners[name] = fn;
  },
});
const chatTab = {
  id: 7,
  url: "https://chatgpt.com/c/conv-1",
  status: "complete",
  active: true,
  incognito: false,
  windowId: 1,
};
const opened = [];
globalThis.chrome = {
  storage: { local: storage(local), session: storage(session) },
  runtime: {
    id: "shale-test",
    onInstalled: event("onInstalled"),
    onStartup: event("onStartup"),
    onMessage: event("onMessage"),
  },
  alarms: { create: async () => {}, onAlarm: event("onAlarm") },
  webNavigation: {
    onCommitted: event("onCommitted"),
    onHistoryStateUpdated: event("onHistoryStateUpdated"),
    onReferenceFragmentUpdated: event("onReferenceFragmentUpdated"),
  },
  tabs: {
    onUpdated: event("onUpdated"),
    onActivated: event("onActivated"),
    onRemoved: event("onRemoved"),
    query: async (query) => {
      const patterns = [query.url ?? []].flat();
      if (patterns.length && !patterns.some((p) => p.includes("chatgpt.com")))
        return [];
      return [chatTab];
    },
    get: async (id) => {
      if (id !== chatTab.id) throw new Error("No tab");
      return chatTab;
    },
    create: async (tab) => {
      opened.push(tab);
      return { id: 99, ...tab };
    },
    remove: async () => {},
  },
  windows: { onFocusChanged: event("onFocusChanged"), WINDOW_ID_NONE: -1 },
  idle: { onStateChanged: event("onStateChanged") },
  bookmarks: {
    onCreated: event("bookmarksCreated"),
    onMoved: event("bookmarksMoved"),
    onChanged: event("bookmarksChanged"),
    onRemoved: event("bookmarksRemoved"),
  },
  history: {
    onVisited: event("historyVisited"),
    onVisitRemoved: event("historyVisitRemoved"),
  },
  // Functions run "in the page": here, against the fake ChatGPT below.
  scripting: {
    executeScript: async ({ func, args }) => [{ result: await func(...args) }],
  },
};

const iso = (minute) => new Date(Date.UTC(2026, 0, 5, 10, minute)).toISOString();
const conversation = (id, minute, answer) => ({
  id,
  title: `Chat ${id}`,
  create_time: Date.UTC(2026, 0, 5, 10, 0) / 1000,
  update_time: Date.UTC(2026, 0, 5, 10, minute) / 1000,
  current_node: "a",
  mapping: {
    u: {
      id: "u",
      parent: null,
      children: ["a"],
      message: {
        id: `${id}-u`,
        author: { role: "user" },
        create_time: Date.UTC(2026, 0, 5, 10, minute - 1) / 1000,
        recipient: "all",
        content: { content_type: "text", parts: [`Question in ${id}`] },
      },
    },
    a: {
      id: "a",
      parent: "u",
      children: [],
      message: {
        id: `${id}-a`,
        author: { role: "assistant" },
        create_time: Date.UTC(2026, 0, 5, 10, minute) / 1000,
        recipient: "all",
        content: { content_type: "text", parts: [answer] },
      },
    },
  },
});
const site = {
  "/api/auth/session": { accessToken: "token" },
  "/backend-api/conversations?offset=0&limit=100&order=updated": {
    items: [
      { id: "conv-2", title: "Chat conv-2", update_time: iso(9) },
      { id: "conv-1", title: "Chat conv-1", update_time: iso(5) },
    ],
    total: 2,
    offset: 0,
  },
  "/backend-api/conversation/conv-1": conversation("conv-1", 5, "Answer one"),
  "/backend-api/conversation/conv-2": conversation("conv-2", 9, "Answer two"),
};
const posts = [],
  statusRequests = [];
let health = { service: "shale", processors: [] };
globalThis.fetch = async (url, options = {}) => {
  url = String(url);
  if (url.startsWith("/")) {
    if (url !== "/api/auth/session")
      assert.equal(options.headers?.Authorization, "Bearer token");
    return site[url]
      ? Response.json(site[url])
      : new Response("missing", { status: 404 });
  }
  const path = new URL(url).pathname;
  if (path === "/health") return Response.json(health);
  if (path.endsWith("/policy")) return Response.json({ protocolVersion: 1 });
  if (path.endsWith("/status")) {
    statusRequests.push(path);
    return Response.json({ records: [] });
  }
  if (options.method === "POST" && path === "/ingest") {
    const body = JSON.parse(options.body);
    const batch = JSON.parse(body.content);
    posts.push({ target: body.target_processor, batch });
    return Response.json({
      protocolVersion: batch.protocolVersion,
      collectorId: batch.collectorId,
      batchId: batch.batchId,
      records: batch.records.map((record) => ({
        recordId: record.recordId,
        jobId: `job:${record.recordId}`,
        status: "received",
      })),
    });
  }
  return new Response("unexpected", { status: 500 });
};

const { createHost } =
  await import("../../scripts/browser-chrome-extension/core/module-host.js");
const { outboxItems } =
  await import("../../scripts/browser-chrome-extension/outbox.js");
const { deliverOutbox, checkConnection } =
  await import("../../scripts/browser-chrome-extension/delivery.js");
const { jobs } = await import("../../scripts/browser-chrome-extension/jobs.js");
const { readySettings } =
  await import("../../scripts/browser-chrome-extension/settings.js");
const { default: registerBrowser } =
  await import("../../extensions/browser/chrome/background.js");
const { default: registerAiChats } =
  await import("../../extensions/ai-chats/chrome/background.ts");
const { allowedTab } = await import("../../extensions/browser/chrome/capture.js");

let notesValidated = 0;
const registerNotes = (runtime) => ({
  id: "notes",
  protocol: {
    batchType: "notes_batch",
    version: 3,
    validate(batch) {
      notesValidated++;
      if (batch.records.some((r) => typeof r.text !== "string"))
        throw new Error("notes need text");
    },
  },
  claims: { hosts: ["notes.example"] },
  actions: { ping: async () => ({ success: true, pong: runtime.id }) },
  jobs: {
    count: {
      async step(job) {
        job.counts.done = (job.counts.done || 0) + 1;
        if (job.counts.done >= 3) job.state = "completed";
      },
      summary: (job) => `counted ${job.counts.done}`,
    },
  },
});
const host = createHost([
  { id: "browser", register: registerBrowser, inject: ["extract"] },
  { id: "ai-chats", register: registerAiChats, inject: ["gemini-dom"] },
  { id: "notes", register: registerNotes, inject: [] },
]);
await readySettings();
const runtime = (id) => host.get(id).runtime;

// Claims: the browser module stays off hosts other enabled modules own.
assert.equal(await runtime("browser").claimedByOther(chatTab.url), true);
assert.equal(await runtime("ai-chats").claimedByOther(chatTab.url), false);
assert.equal(await runtime("browser").claimedByOther("https://example.com/"), false);
assert.deepEqual(await allowedTab({ url: "https://www.notes.example/x" }), {
  allowed: false,
  reason: "Captured by another Shale module",
});
local.modules = { notes: false };
assert.equal(await runtime("browser").claimedByOther("https://notes.example/x"), false);
local.modules = {};

// Each module validates its own records and its rows carry its route.
await assert.rejects(() => runtime("notes").enqueue([{ recordId: "n0" }]), /need text/);
await runtime("notes").enqueue([{ recordId: "n1", text: "hello" }]);
await runtime("browser").enqueue([
  { type: "page_visit", recordId: "b1", url: "https://example.com", title: "Example", textContent: "Body" },
]);
await assert.rejects(
  () => runtime("browser").enqueue([{ type: "ai_chat_snapshot", recordId: "x" }]),
  /Invalid browser field/,
);
assert.equal(notesValidated, 2);
const rows = await outboxItems();
assert.deepEqual(
  rows.map((r) => [r.id, r.processor, r.batchType, r.protocolVersion]).sort(),
  [
    ["b1", "browser", "browser_batch", 1],
    ["n1", "notes", "notes_batch", 3],
  ],
);

// One delivery pass sends one batch per processor, then polls each processor's status.
await deliverOutbox();
assert.deepEqual(
  posts.map((p) => [p.target, p.batch.type, p.batch.protocolVersion]).sort(),
  [
    ["browser", "browser_batch", 1],
    ["notes", "notes_batch", 3],
  ],
);
assert.deepEqual(statusRequests.sort(), [
  "/connectors/browser/status",
  "/connectors/notes/status",
]);

// A processor missing on the server marks only that module unavailable.
health = {
  service: "shale",
  processors: [
    { name: "browser", durable: true, protocolVersions: [1] },
    { name: "notes", durable: true, protocolVersions: [1] },
  ],
};
const connection = await checkConnection([
  { id: "browser", protocolVersion: 1 },
  { id: "notes", protocolVersion: 3 },
  { id: "ai-chats", protocolVersion: 1 },
]);
assert.equal(connection.modules.browser.available, true);
assert.match(connection.modules.notes.error, /protocol 3/);
assert.match(connection.modules["ai-chats"].error, /not loaded/);
assert.deepEqual(local.capturePolicies[SERVER].modules, { browser: { protocolVersion: 1 } });
// Restore the ai-chats policy used below (fast fetches, auto-sync off).
local.capturePolicies[SERVER].modules["ai-chats"] = {
  providers: ["chatgpt", "claude", "gemini"],
  autoSyncMinutes: 0,
  fetchDelayMs: 1,
  maxConversationsPerSync: 100,
};

// Jobs dispatch to their module and record its summary.
await runtime("notes").createJob("count", {});
await host.resumeJobs();
const counted = (await jobs()).find((job) => job.module === "notes");
assert.equal(counted.state, "completed");
assert.equal(counted.summary, "counted 3");

// ai-chats: capture the open conversation through the page's own session.
const aiChats = host.get("ai-chats").definition;
const captured = await aiChats.actions.capture_current({});
assert.equal(captured.title, "Chat conv-1");
const snapshot = (await outboxItems()).find((r) => r.processor === "ai-chats");
assert.equal(snapshot.batchType, "ai_chat_batch");
assert.deepEqual(
  snapshot.record.messages.map((m) => m.text),
  ["Question in conv-1", "Answer one"],
);
assert.equal((await aiChats.actions.capture_current({})).message, "Already up to date.");

// ai-chats: a sync lists conversations newest first and fetches what changed.
await aiChats.actions.sync({ provider: "chatgpt" });
await host.resumeJobs();
const sync = (await jobs()).find((job) => job.module === "ai-chats");
assert.equal(sync.state, "completed", sync.error);
assert.deepEqual(sync.counts, { listed: 2, changed: 2, fetched: 2, failed: 0 });
assert.match(sync.summary, /ChatGPT sync completed: 2 changed of 2 listed/);
assert.equal(opened.length, 0, "an open ChatGPT tab is reused");
const conversations = new Set(
  (await outboxItems())
    .filter((r) => r.processor === "ai-chats")
    .map((r) => r.record.conversationId),
);
assert.deepEqual([...conversations].sort(), ["conv-1", "conv-2"]);
assert.equal(local["module:ai-chats:syncedThrough:chatgpt"], Date.parse(iso(9)));

// The next sync stops at the first conversation it already has.
await aiChats.actions.sync({ provider: "chatgpt" });
await host.resumeJobs();
const second = (await jobs())
  .filter((job) => job.module === "ai-chats")
  .sort((a, b) => b.createdAt - a.createdAt)[0];
assert.deepEqual(second.counts, { listed: 2, changed: 0, fetched: 0, failed: 0 });

// The service worker routes `<module>:<action>` messages and refuses disabled modules.
await import("../../scripts/browser-chrome-extension/background.js");
const message = (request) =>
  new Promise((resolve) =>
    listeners.onMessage(request, { id: "shale-test" }, resolve),
  );
assert.deepEqual(await message({ action: "ai-chats:nope" }), {
  success: false,
  error: "Unknown action",
});
assert.equal((await message({ action: "ai-chats:capture_current" })).success, true);
await message({ action: "set_module_enabled", id: "ai-chats", enabled: false });
assert.match(
  (await message({ action: "ai-chats:capture_current" })).error,
  /turned off/,
);
const status = (await message({ action: "get_status" })).status;
assert.deepEqual(
  status.modules.map((m) => [m.id, m.enabled]),
  [
    ["browser", true],
    ["ai-chats", false],
  ],
);
console.log("Chrome module checks passed");
