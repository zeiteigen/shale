import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
globalThis.indexedDB = indexedDB;
const local = {
    totalIngestedCount: 500,
    initialSyncCompleted: true,
    excludeDomains: [],
    capturePolicies: {},
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
globalThis.chrome = {
  storage: { local: storage(local), session: storage(session) },
  history: { search: async () => [] },
};
const { initializeSettings, settings } =
  await import("../../scripts/browser-chrome-extension/settings.js");
const { enqueueRecords, outboxItems, updateItems, outboxSummary } =
  await import("../../scripts/browser-chrome-extension/outbox.js");
const { deliverOutbox } =
  await import("../../scripts/browser-chrome-extension/delivery.js");
await initializeSettings();
const collector = local.collectorId;
await initializeSettings();
assert.equal(local.totalIngestedCount, 500);
assert.equal(local.initialSyncCompleted, true);
assert.equal(local.collectorId, collector);
const config = await settings(),
  record = {
    type: "page_visit",
    recordId: "stable",
    url: "https://example.com",
    title: "Page",
    textContent: "Useful evidence",
  };
await enqueueRecords([record], config);
await enqueueRecords([record], config);
assert.equal((await outboxItems()).length, 1);
const newSettings = { ...config, serverUrl: "http://different.invalid/ingest" };
await enqueueRecords([{ ...record, recordId: "other" }], newSettings);
assert.equal(
  (await outboxItems()).find((row) => row.id === "stable").endpoint,
  config.serverUrl,
);
globalThis.fetch = async () => {
  throw new Error("Host offline");
};
await deliverOutbox();
const offline = (await outboxItems()).find((row) => row.id === "stable");
assert.equal(offline.state, "pending");
assert.equal(offline.attempts, 1);
assert.equal(offline.record.textContent, record.textContent);
assert.ok(offline.nextAttemptAt > Date.now());
await updateItems(["stable", "other"], (row) => ({ ...row, nextAttemptAt: 0 }));
globalThis.fetch = async (url, options) => {
  if (options?.method === "POST") {
    const batch = JSON.parse(JSON.parse(options.body).content);
    return Response.json({
      protocolVersion: 1,
      collectorId: batch.collectorId,
      batchId: batch.batchId,
      records: batch.records.map((record) => ({
        recordId: record.recordId,
        jobId: "job:" + record.recordId,
        status: "duplicate",
      })),
    });
  }
  return Response.json({
    records: [{ jobId: "job:stable", status: "indexed" }],
  });
};
await deliverOutbox();
assert.equal(
  (await outboxItems()).find((row) => row.id === "stable").state,
  "indexed",
);
assert.equal((await outboxSummary()).sentCount, 1);
await deliverOutbox();
assert.equal((await outboxSummary()).sentCount, 2);
const { historyStep } =
  await import("../../scripts/browser-chrome-extension/history-sync.js");
const job = {
  historyWindows: [{ start: 0, end: 2 }],
  counts: { history: 0 },
  warnings: [],
};
chrome.history.search = async () =>
  new Array(10000).fill({
    id: "tied",
    url: "https://example.com",
    lastVisitTime: 1,
  });
await historyStep(job);
assert.equal(job.historyWindows.length, 2);
await historyStep(job);
assert.equal(job.incomplete, true);
assert.match(job.warnings[0], /timestamp/);
const { createImport, updateImport } =
  await import("../../scripts/browser-chrome-extension/import-jobs.js");
const { importJobs } =
  await import("../../scripts/browser-chrome-extension/outbox.js");
const created = await createImport({
  importTabs: false,
  importBookmarks: false,
  importHistory: true,
  historyRange: "7d",
});
assert.equal((await importJobs())[0].id, created.jobId);
await updateImport(created.jobId, "cancel");
assert.equal((await importJobs())[0].state, "cancelled");
await updateImport(created.jobId, "resume");
assert.equal((await importJobs())[0].state, "running");
chrome.history.search = async () => {
  await updateImport(created.jobId, "cancel");
  return [];
};
const { resumeImports } =
  await import("../../scripts/browser-chrome-extension/import-jobs.js");
await resumeImports();
assert.equal((await importJobs())[0].state, "cancelled");
console.log("Chrome outbox checks passed");
const backfillJob = {
  options: { includeHistoryVisits: true },
  historyBounds: { start: 100, end: 200 },
  historyWindows: [],
  historyItems: [
    {
      id: "old",
      url: "https://example.com/old",
      lastVisitTime: 150,
      title: "Old page",
    },
  ],
  counts: { history: 0, historyVisits: 0 },
  warnings: [],
};
chrome.history.getVisits = async () => {
  throw new Error("API temporarily unavailable");
};
await assert.rejects(() => historyStep(backfillJob), /unavailable/);
assert.equal(backfillJob.historyItems.length, 1);
assert.equal(backfillJob.counts.history, 0);
chrome.history.getVisits = async () => [
  { visitId: "within", visitTime: 150, transition: "link" },
  { visitId: "outside", visitTime: 250 },
];
await historyStep(backfillJob);
assert.equal(backfillJob.pendingVisits.length, 1);
await historyStep(backfillJob);
const backfilled = (await outboxItems()).find(
  (row) => row.id === "history-visit:within",
);
assert.equal(backfilled.record.kind, "history_backfill");
assert.equal(backfilled.record.attended, false);
const windowJob = {
  historyWindows: [{ start: 0, end: 100 }],
  counts: { history: 0 },
  warnings: [],
};
chrome.history.search = async () => {
  throw new Error("Search unavailable");
};
await assert.rejects(() => historyStep(windowJob), /unavailable/);
assert.equal(windowJob.historyWindows.length, 1);
const { fitCapture } =
  await import("../../scripts/browser-chrome-extension/capture-budget.js");
const heavy = {
  ...record,
  textContent: "Meaningful database evidence. ".repeat(1000),
  html: "&amp;".repeat(100000),
  blocks: [
    {
      kind: "paragraph",
      text: "Meaningful database evidence. ".repeat(400),
      locator: "block:0",
      headingPath: [],
    },
  ],
  links: new Array(100).fill({
    url: "https://example.com/" + "a".repeat(7000),
    text: "Link",
  }),
  images: [],
  extraction: {
    method: "semantic-root",
    version: "blocks-v1",
    quality: "full",
    originalChars: 29000,
    truncated: false,
    reasons: [],
  },
};
const bounded = fitCapture(heavy);
assert.ok(new TextEncoder().encode(JSON.stringify(bounded)).length <= 450000);
assert.ok(bounded.textContent.includes("Meaningful database evidence"));
assert.equal(bounded.extraction.truncated, true);
assert.equal(bounded.html, "");
