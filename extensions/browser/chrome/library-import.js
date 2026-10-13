import { hasRecord, runtime } from "./runtime.js";
import { captureTab } from "./capture.js";
import { bookmarkSnapshot, queueBookmark } from "./bookmark-sync.js";
import { historyWindows, historyStep } from "./history-sync.js";
/** Open tabs, then bookmarks, then history, as one resumable core job. */
export async function createImport(options = {}) {
  const job = {
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
  const created = await runtime().createJob("library-import", job);
  return { success: true, jobId: created.id };
}
export async function step(job) {
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
export function summary(job) {
  const c = job.counts;
  return `Import ${job.state} (${job.stage}): ${c.tabs} tabs, ${c.bookmarks} bookmarks, ${c.history} history, ${c.historyVisits || 0} backfilled visits, ${c.skipped} skipped. ${job.error || job.warnings.join(" ")}`;
}
