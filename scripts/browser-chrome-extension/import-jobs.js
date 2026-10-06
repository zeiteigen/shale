import { settings } from "./settings.js";
import { importJobs, saveImport, hasRecord } from "./outbox.js";
import { captureTab } from "./capture.js";
import { bookmarkSnapshot, queueBookmark } from "./bookmark-sync.js";
import { historyWindows, historyStep } from "./history-sync.js";
let running;
export async function createImport(options = {}) {
  const config = await settings();
  const job = {
    id: crypto.randomUUID(),
    state: "running",
    endpoint: config.serverUrl,
    createdAt: Date.now(),
    stage: "tabs",
    options: {
      importTabs: true,
      importBookmarks: true,
      importHistory: true,
      historyRange: "7d",
      includeHistoryVisits: false,
      ...options,
    },
    counts: { tabs: 0, bookmarks: 0, history: 0, historyVisits: 0, skipped: 0 },
    cursor: 0,
    warnings: [],
  };
  if (job.options.importBookmarks) job.bookmarks = await bookmarkSnapshot();
  if (job.options.importHistory) {
    job.historyWindows = historyWindows(job.options.historyRange);
    job.historyBounds = { ...job.historyWindows[0] };
  }
  await saveImport(job);
  return { success: true, jobId: job.id };
}
async function step(job) {
  const config = await settings();
  if (config.serverUrl !== job.endpoint)
    throw new Error("Restore the import destination before resuming this job");
  if (job.stage === "tabs") {
    if (!job.options.importTabs) {
      job.stage = "bookmarks";
      job.cursor = 0;
      return;
    }
    if (!job.tabs)
      job.tabs = (await chrome.tabs.query({})).map((tab) => ({
        id: tab.id,
        url: tab.url,
      }));
    const entry = job.tabs[job.cursor];
    if (!entry) {
      job.stage = "bookmarks";
      job.cursor = 0;
      delete job.tabs;
      return;
    }
    const recordId = `import:${job.id}:tab:${job.cursor}`;
    let result;
    if (await hasRecord(recordId)) result = { success: true };
    else {
      let tab;
      try {
        tab = await chrome.tabs.get(entry.id);
      } catch {
        result = { skipped: true };
      }
      if (tab)
        result =
          tab.url === entry.url
            ? await captureTab(tab, {
                recordId,
                transitionType: "batch_open_tabs",
              })
            : { skipped: true };
    }
    if (result.success) job.counts.tabs++;
    else job.counts.skipped++;
    job.cursor++;
  } else if (job.stage === "bookmarks") {
    if (!job.options.importBookmarks) {
      job.stage = "history";
      return;
    }
    if (!job.bookmarks) job.bookmarks = await bookmarkSnapshot();
    const item = job.bookmarks[job.cursor];
    if (!item) {
      job.stage = "history";
      job.cursor = 0;
      delete job.bookmarks;
      return;
    }
    if (await queueBookmark(item, `import:${job.id}:bookmark:${job.cursor}`))
      job.counts.bookmarks++;
    else job.counts.skipped++;
    job.cursor++;
  } else if (!job.options.importHistory || (await historyStep(job))) {
    job.state = job.incomplete ? "incomplete" : "completed";
    job.stage = "done";
    await chrome.storage.local.set({
      initialSyncCompleted: !job.incomplete,
      lastFullImportTime: Date.now(),
      lastFullImportResults: job.counts,
    });
  }
}
export function resumeImports() {
  return (running ??= (async () => {
    for (const job of (await importJobs())
      .filter((job) => job.state === "running")
      .slice(0, 1)) {
      for (let i = 0; i < 20 && job.state === "running"; i++) {
        const before = (await importJobs()).find(
          (saved) => saved.id === job.id,
        );
        if (before?.state !== "running") break;
        try {
          await step(job);
          job.error = "";
        } catch (error) {
          job.state = "failed";
          job.error = error.message;
        }
        const after = (await importJobs()).find((saved) => saved.id === job.id);
        if (after?.state === "cancelled") job.state = "cancelled";
        await saveImport(job);
      }
    }
  })().finally(() => {
    running = undefined;
  }));
}
export async function updateImport(id, action) {
  const job = (await importJobs()).find((job) => job.id === id);
  if (!job) throw new Error("Unknown import job");
  job.state = action === "cancel" ? "cancelled" : "running";
  job.error = "";
  await saveImport(job);
}
