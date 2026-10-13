/**
 * The search-queries Chrome module against fake tabs: results-page claims, page reads, and which
 * navigations count as opening a result (same tab, new tab from the page, not deeper links).
 */
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
globalThis.indexedDB = indexedDB;
// Keep delivery offline so captures remain inspectable and never reach a running local host.
globalThis.fetch = async () => { throw new TypeError("Offline fixture"); };

const SERVER = "http://127.0.0.1:7425/ingest";
const local = {
    serverUrl: SERVER,
    capturePolicies: {
      [SERVER]: {
        modules: {
          "search-queries": { protocolVersion: 1, engines: ["google", "bing", "duckduckgo"], captureAiOverview: true },
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
          (Array.isArray(keys) ? keys : [keys]).filter((k) => data[k] !== undefined).map((k) => [k, data[k]]),
        ),
  set: async (values) => Object.assign(data, values),
  remove: async (key) => {
    delete data[key];
  },
});

const SERP = "https://www.google.com/search?q=Rust+lifetimes";
const tabs = new Map();
const tab = (id, url, extra = {}) => tabs.set(id, { id, url, title: url, status: "complete", active: true, incognito: false, windowId: 1, ...extra });
let page = {};
globalThis.chrome = {
  storage: { local: storage(local), session: storage(session) },
  tabs: {
    get: async (id) => {
      if (!tabs.has(id)) throw new Error("No tab");
      return tabs.get(id);
    },
    query: async () => [...tabs.values()],
  },
  // The injected reader is "loaded" by the files call and run by the func call.
  scripting: {
    executeScript: async ({ func, args }) => (func ? [{ result: await func(...args) }] : [{}]),
  },
};
globalThis.__shaleInjected = { "search-queries/serp": async (args) => ({ url: tabs.get(1).url, ...page(args) }) };

const { createHost } = await import("../../scripts/browser-chrome-extension/core/module-host.js");
const { outboxItems } = await import("../../scripts/browser-chrome-extension/outbox.js");
const { readySettings } = await import("../../scripts/browser-chrome-extension/settings.js");
const { default: registerBrowser } = await import("../../extensions/browser/chrome/background.js");
const { default: registerSearch } = await import("../../extensions/search-queries/chrome/background.ts");

const host = createHost([
  { id: "browser", register: registerBrowser, inject: ["extract"] },
  { id: "search-queries", register: registerSearch, inject: ["serp"] },
]);
await readySettings();
const browser = host.get("browser").runtime;
const search = host.get("search-queries").definition;

// Claims: results pages only, not the rest of the engine's site.
assert.equal(await browser.claimedByOther(SERP), true);
assert.equal(await browser.claimedByOther("https://www.bing.com/search?q=x"), true);
assert.equal(await browser.claimedByOther("https://www.google.com/search?q=x&tbm=isch"), false);
assert.equal(await browser.claimedByOther("https://docs.google.com/document/d/1"), false);
assert.equal(await browser.claimedByOther("https://www.google.com/maps"), false);
assert.equal(await host.get("search-queries").runtime.claimedByOther(SERP), false);

let clock = Date.UTC(2026, 0, 5, 10, 0);
const navigate = (tabId, url, transitionType = "link", transitionQualifiers = [], extra = {}) => {
  if (!tabs.has(tabId)) tab(tabId, url, extra);
  Object.assign(tabs.get(tabId), { url, title: url, ...extra });
  return search.listeners.navigation({ tabId, frameId: 0, url, transitionType, transitionQualifiers, timeStamp: (clock += 1000) });
};
const complete = (tabId, title) => {
  if (title) tabs.get(tabId).title = title;
  return search.listeners.tabComplete(tabId, tabs.get(tabId));
};
const records = async (type) => (await outboxItems()).map((row) => row.record).filter((r) => r.type === type);

// A results page is read once loaded, with its AI Overview.
page = (args) => ({
  results: [
    { url: "https://doc.rust-lang.org/book/ch10-03-lifetime-syntax.html", title: "Validating References with Lifetimes",
      description: "Lifetimes ensure references are valid as long as we need them.", rank: 1 },
    { url: "https://example.org/b", title: "Lifetimes explained", rank: 2 },
  ],
  ...(args.overview ? { overview: { text: "Lifetimes describe how long references stay valid.", citations: [], complete: true } } : {}),
});
await navigate(1, SERP, "typed");
await complete(1, "Rust lifetimes - Google Search");
const [query] = await records("search_query");
assert.equal(query.query, "Rust lifetimes");
assert.equal(query.engine, "google");
assert.equal(query.aiOverview.text, "Lifetimes describe how long references stay valid.");
assert.equal(query.results.length, 2);

// A result clicked in the same tab, through Google's click tracker and with tracking parameters.
await navigate(1, "https://www.google.com/url?q=https://doc.rust-lang.org/book/ch10-03-lifetime-syntax.html&sa=U");
await navigate(1, "https://doc.rust-lang.org/book/ch10-03-lifetime-syntax.html?utm_source=google", "link", ["client_redirect"]);
await complete(1, "Validating References with Lifetimes - The Rust Book");
let visits = await records("search_visit");
assert.equal(visits.length, 1, "the click tracker and the result's redirect are one visit");
assert.deepEqual(
  { url: visits[0].url, title: visits[0].title, rank: visits[0].rank, searchId: visits[0].searchId, query: visits[0].query },
  { url: "https://doc.rust-lang.org/book/ch10-03-lifetime-syntax.html", title: "Validating References with Lifetimes - The Rust Book",
    rank: 1, searchId: query.searchId, query: "Rust lifetimes" },
);
assert.equal(visits[0].description, "Lifetimes ensure references are valid as long as we need them.");
assert.equal(visits[0].searchedAt, query.searchedAt, "visits retain the time of the original search");

// A link followed from the result is not a result of the search.
await navigate(1, "https://doc.rust-lang.org/book/ch11-00-testing.html");
await complete(1);
assert.equal((await records("search_visit")).length, 1);

// Back to the results continues the same search; a result opened in a new tab counts.
await navigate(1, SERP, "link", ["forward_back"]);
await complete(1);
// A new tab may commit about:blank before the result; that blank page is not a result.
await navigate(2, "about:blank", "link", [], { openerTabId: 1 });
await navigate(2, "https://example.org/b", "link", [], { openerTabId: 1 });
tabs.delete(2);
await search.listeners.tabRemoved(2);
visits = await records("search_visit");
assert.equal(visits.length, 2);
const opened = visits.find((visit) => visit.url === "https://example.org/b");
assert.equal(opened.searchId, query.searchId);
assert.equal(opened.title, undefined, "a tab closed before loading sends its URL alone");
// An unchanged re-read of the same search queues nothing new.
assert.equal((await records("search_query")).length, 1);

// The engine's own tabs (Images) are not results.
await navigate(1, "https://www.google.com/search?q=Rust+lifetimes&tbm=isch");
await complete(1);
assert.equal((await records("search_visit")).length, 2);

// A new query is a new search; a typed URL from its page is not a result.
page = () => ({ results: [{ url: "https://example.com/", title: "Example", rank: 1 }] });
await navigate(1, "https://www.bing.com/search?q=borrow+checker", "form_submit");
await complete(1);
const queries = await records("search_query");
assert.equal(queries.length, 2);
const bing = queries.find((record) => record.engine === "bing");
assert.notEqual(bing.searchId, query.searchId);
assert.equal(bing.aiOverview, undefined, "only Google's overview is read");
await navigate(1, "https://example.com/", "typed");
await complete(1);
assert.equal((await records("search_visit")).length, 2);

// Incognito tabs are ignored.
await navigate(3, "https://duckduckgo.com/?q=secret", "typed", [], { incognito: true });
assert.equal((await records("search_query")).length, 2);

// The popup's status reflects the last search.
const status = await search.status();
assert.equal(status.lastQuery, "borrow checker");
assert.equal(status.lastEngine, "Bing");
assert.equal(status.visits, 2);
console.log("Search queries module checks passed");
// Pending read-again timers would otherwise keep the process alive.
process.exit(0);
