import { readySettings, settings } from "./settings.js";
import { outboxSummary, importJobs } from "./outbox.js";
import { deliverOutbox, retryFailures, checkConnection } from "./delivery.js";
import { captureTab } from "./capture.js";
import { createImport, resumeImports, updateImport } from "./import-jobs.js";
import { syncBookmarkChanges, removedBookmark } from "./bookmark-sync.js";
import { removedHistory, queueHistoryItem } from "./history-sync.js";
import {
  serialize,
  navigation,
  capturePending,
  resumeCaptures,
  activated,
  focused,
  closed,
  attentionHeartbeat,
} from "./activity.js";
const report = (promise) =>
  promise.catch(async (error) => {
    console.warn("Shale browser:", error);
    await chrome.storage.local.set({
      lastCaptureError: error.message || String(error),
    });
  });
async function wake() {
  await readySettings();
  await resumeCaptures();
  await resumeImports();
  await deliverOutbox();
}
async function initialize() {
  await readySettings();
  await chrome.alarms.create("shale_delivery", { periodInMinutes: 1 });
  report(wake());
}
chrome.runtime.onInstalled.addListener(() => report(initialize()));
chrome.runtime.onStartup.addListener(() => report(initialize()));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "shale_delivery")
    report(
      serialize(async () => {
        await attentionHeartbeat();
        await wake();
      }),
    );
});
chrome.webNavigation.onCommitted.addListener((details) =>
  report(serialize(() => navigation(details))),
);
chrome.webNavigation.onHistoryStateUpdated.addListener((details) =>
  report(serialize(() => navigation(details))),
);
chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
  if (
    new URL(details.url).hash.startsWith("#/") ||
    new URL(details.url).hash.startsWith("#!")
  )
    report(serialize(() => navigation(details)));
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.status === "complete")
    report(
      serialize(async () => {
        await capturePending(id);
        await deliverOutbox();
      }),
    );
});
chrome.tabs.onActivated.addListener((info) =>
  report(serialize(() => activated(info))),
);
chrome.windows.onFocusChanged.addListener((id) =>
  report(serialize(() => focused(id))),
);
chrome.tabs.onRemoved.addListener((id) => report(serialize(() => closed(id))));
chrome.idle.onStateChanged.addListener(() =>
  report(serialize(() => attentionHeartbeat())),
);
chrome.bookmarks.onCreated.addListener(() =>
  report(
    createImport({
      importTabs: false,
      importBookmarks: true,
      importHistory: false,
    }).then(() => resumeImports()),
  ),
);
chrome.bookmarks.onMoved.addListener(() =>
  report(
    createImport({
      importTabs: false,
      importBookmarks: true,
      importHistory: false,
    }).then(() => resumeImports()),
  ),
);
chrome.bookmarks.onChanged.addListener(() =>
  report(
    createImport({
      importTabs: false,
      importBookmarks: true,
      importHistory: false,
    }).then(() => resumeImports()),
  ),
);
chrome.bookmarks.onRemoved.addListener((id, info) =>
  report(removedBookmark(id, info)),
);
chrome.history.onVisited.addListener((item) =>
  report(
    serialize(async () => {
      if ((await settings()).autoSyncActive) await queueHistoryItem(item);
    }),
  ),
);
chrome.history.onVisitRemoved.addListener((info) =>
  report(removedHistory(info)),
);
chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  (async () => {
    switch (request.action) {
      case "get_status":
        return {
          success: true,
          status: {
            ...(await settings()),
            outbox: await outboxSummary(),
            imports: (await importJobs()).map(
              ({
                tabs,
                bookmarks,
                historyItems,
                historyWindows,
                pendingVisits,
                backfillPage,
                ...job
              }) => job,
            ),
          },
        };
      case "test_connection":
        return checkConnection();
      case "ingest_current_tab": {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab) throw new Error("No active tab");
        const result = await captureTab(tab);
        report(deliverOutbox());
        return result;
      }
      case "ingest_all_tabs":
      case "sync_bookmarks":
      case "sync_history":
      case "run_full_import": {
        const options =
          request.action === "ingest_all_tabs"
            ? { importTabs: true, importBookmarks: false, importHistory: false }
            : request.action === "sync_bookmarks"
              ? {
                  importTabs: false,
                  importBookmarks: true,
                  importHistory: false,
                }
              : request.action === "sync_history"
                ? {
                    importTabs: false,
                    importBookmarks: false,
                    importHistory: true,
                    historyRange: request.range || "24h",
                  }
                : request.options;
        const result = await createImport(options);
        report(resumeImports().then(deliverOutbox));
        return result;
      }
      case "retry_failed":
        await retryFailures();
        report(deliverOutbox());
        return { success: true };
      case "cancel_import":
      case "resume_import":
        await updateImport(
          request.id,
          request.action === "cancel_import" ? "cancel" : "resume",
        );
        report(resumeImports());
        return { success: true };
      case "reset_sync_state":
        await chrome.storage.local.set({ initialSyncCompleted: false });
        return { success: true };
      default:
        throw new Error("Unknown action");
    }
  })().then(respond, (error) =>
    respond({ success: false, error: error.message }),
  );
  return true;
});
report(initialize());
