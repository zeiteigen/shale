import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { parseHTML } from "linkedom";
import register from "../../extensions/youtube/chrome/background.ts";
import tracker from "../../extensions/youtube/chrome/inject/tracker.ts";

globalThis.indexedDB = indexedDB;
globalThis.fetch = async () => { throw new TypeError("Offline fixture"); };
const ID = "abcdefghijk", SERVER = "http://127.0.0.1:7425/ingest", URL = `https://www.youtube.com/watch?v=${ID}`;
const local = { collectorId: "youtube-fixture", browserInstanceId: "instance", serverUrl: SERVER, capturePolicies: { [SERVER]: { modules: { youtube: { protocolVersion: 1, enabled: true,
  captureSubtitles: true, preferredLanguages: ["en"] } } } } }, session = {};
const storage = data => ({ get: async keys => keys === null ? { ...data } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => data[k] !== undefined).map(k => [k, data[k]])),
  set: async values => Object.assign(data, values), remove: async key => delete data[key] });
const tabs = new Map([[1, { id: 1, url: URL, incognito: false, active: true, status: "complete" }]]);
const { document, window } = parseHTML(`<html><body><ytd-watch-flexy video-id="${ID}"><div id="movie_player"><video class="html5-main-video"></video></div></ytd-watch-flexy></body></html>`);
Object.assign(globalThis, { document, window, location: { href: URL } });
const video = document.querySelector("video");
Object.assign(video, { currentTime: 0, duration: 100, playbackRate: 1, paused: false, ended: false, seeking: false, readyState: 4 });
let elapsed = 0, clock = Date.UTC(2026, 9, 12), captionReads = 0, definition, runtime;
Date.now = () => clock;
Object.defineProperty(globalThis, "performance", { value: { now: () => elapsed }, configurable: true });
const intervals = new Map();
globalThis.setInterval = callback => { const id = intervals.size + 1; intervals.set(id, callback); return id; };
globalThis.clearInterval = id => intervals.delete(id);
const observers = [];
globalThis.MutationObserver = class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() {} };
const messages = [];
const metadata = { title: "Fixture video", description: "Description", channel: { name: "Fixture channel" }, duration: 100 };
globalThis.__shaleInjected = {
  "youtube/video": () => ({ metadata }), "youtube/tracker": tracker,
  "youtube/subtitles": () => { captionReads++; return { language: "en", generated: false,
    cues: [{ start: 0, end: 50, text: "First section" }, { start: 50, end: 100, text: "Second section" }] }; },
};
globalThis.chrome = {
  storage: { local: storage(local), session: storage(session) },
  tabs: { get: async id => { if (!tabs.has(id)) throw new Error("No tab"); return tabs.get(id); }, query: async () => [...tabs.values()] },
  scripting: { executeScript: async ({ func, args }) => func ? [{ result: await func(...args) }] : [{}] },
  runtime: { sendMessage: request => { const promise = definition.actions[request.action.split(":")[1]](request); messages.push(promise); return promise; } },
};
const { createHost } = await import("../../scripts/browser-chrome-extension/core/module-host.js");
const { readySettings } = await import("../../scripts/browser-chrome-extension/settings.js");
const { outboxItems } = await import("../../scripts/browser-chrome-extension/outbox.js");
const registry = [{ id: "youtube", register, inject: ["video", "tracker", "subtitles"] }];
let host = createHost(registry); definition = host.get("youtube").definition; runtime = host.get("youtube").runtime;
await readySettings();
assert.equal(await host.claimant(URL), "youtube");
assert.equal(await host.claimant(`https://www.youtube.com/shorts/${ID}`), undefined);
await definition.listeners.tabComplete(1, tabs.get(1));
const settle = async () => { for (let n = 0; n < 10; n++) { await Promise.allSettled(messages.splice(0)); await Promise.resolve(); } };
const event = name => video.dispatchEvent(new window.Event(name));
const advance = async (position, seconds = Math.abs(position - video.currentTime) / video.playbackRate) => {
  elapsed += seconds * 1000; clock += seconds * 1000; video.currentTime = position; event("timeupdate"); await settle();
};
const seek = async position => { video.seeking = true; video.currentTime = position; event("seeking"); await settle();
  video.seeking = false; event("seeked"); event("playing"); await settle(); };
const records = async type => (await outboxItems()).map(row => row.record).filter(record => record.type === type);

await seek(70); await advance(71); // Seeking alone does not qualify.
assert.equal(captionReads, 0);
await seek(0); await advance(25);
assert.equal(captionReads, 0);
await seek(0); await advance(25); // Replaying the same quarter still does not qualify.
assert.equal(captionReads, 0);
// Ads and pauses are excluded, even when the underlying media element advances.
const player = document.querySelector("#movie_player");
player.classList.add("ad-showing"); observers.forEach(observer => observer.callback());
await advance(50); player.classList.remove("ad-showing"); observers.forEach(observer => observer.callback());
await seek(0); video.paused = true; event("pause"); await advance(20); video.paused = false; event("playing");
assert.equal(captionReads, 0);
// Restart the worker and revisit in a new tab: persistent coverage survives both.
globalThis.__shaleYoutubeTracker.stop(); await settle();
host = createHost(registry); definition = host.get("youtube").definition; runtime = host.get("youtube").runtime;
await definition.listeners.tabRemoved(1); tabs.delete(1); tabs.set(2, { id: 2, url: URL, incognito: false, active: true });
video.currentTime = 60; await definition.listeners.tabComplete(2, tabs.get(2));
video.playbackRate = 2; event("ratechange"); await advance(85, 12.5);
assert.equal(captionReads, 1);
const captures = await records("youtube_video");
assert.deepEqual(captures.at(-1).ranges, [[0, 25], [60, 85]]);
assert.equal((await records("youtube_subtitles")).length, 1);
await definition.wake(); assert.equal(captionReads, 1);
// An explicit retry creates fresh immutable records, even when the transcript text is unchanged.
clock += 1;
await definition.actions.capture_current(); assert.equal(captionReads, 2);
assert.equal((await records("youtube_subtitles")).length, 2);
// A full/failed outbox leaves a cumulative snapshot recoverable after the tab closes.
const enqueue = runtime.enqueue; runtime.log = () => {};
runtime.enqueue = async () => { throw new Error("Full outbox fixture"); };
await advance(86);
await globalThis.__shaleYoutubeTracker.flush(); await settle();
assert.ok(local[`module:youtube:video:${ID}`].pending);
runtime.enqueue = enqueue;
globalThis.__shaleYoutubeTracker.stop(); await settle();
await definition.listeners.tabRemoved(2); tabs.delete(2);
await definition.wake();
assert.equal(local[`module:youtube:video:${ID}`].pending, undefined);
assert.ok((await records("youtube_video")).some(record => record.ranges.some(([start,end]) => start === 60 && end === 86)));
// Incognito is never injected or queued.
tabs.set(3, { id: 3, url: URL, incognito: true });
await definition.listeners.tabComplete(3, tabs.get(3)); assert.equal(captionReads, 2);
globalThis.__shaleYoutubeTracker?.stop(); await settle();
console.log("YouTube Chrome checks passed");
process.exit(0);
