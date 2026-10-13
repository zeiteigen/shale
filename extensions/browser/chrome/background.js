/**
 * Browser module for the Shale Chrome extension: live page capture, attention, history,
 * and bookmarks, delivered to the `browser` Shale extension.
 */
import { validateBrowserPayload } from "../../../lib/browser-validation.ts";
import { bind, settings } from "./runtime.js";
import { captureTab } from "./capture.js";
import { createImport, step, summary } from "./library-import.js";
import { removedBookmark } from "./bookmark-sync.js";
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

const bookmarksOnly = {
  importTabs: false,
  importBookmarks: true,
  importHistory: false,
};

export default function register(runtime) {
  bind(runtime);
  const bookmarkChanged = () =>
    createImport(bookmarksOnly).then(() => runtime.resume());
  return {
    id: "browser",
    label: "Browser",
    protocol: {
      batchType: "browser_batch",
      version: 1,
      validate: validateBrowserPayload,
    },
    defaults: {
      autoSyncActive: true,
      excludeSocialMedia: true,
      excludeDomains: [
        "x.com",
        "twitter.com",
        "reddit.com",
        "facebook.com",
        "instagram.com",
        "tiktok.com",
        "linkedin.com",
        "youtube.com",
        "mail.google.com",
        "accounts.google.com",
      ],
      sessionIdleMinutes: 30,
      initialSyncCompleted: false,
      currentGoal: "",
    },
    wake: () => resumeCaptures(),
    listeners: {
      alarm: () => serialize(() => attentionHeartbeat()),
      navigation: (details) => serialize(() => navigation(details)),
      tabComplete: (tabId) => serialize(() => capturePending(tabId)),
      tabActivated: (info) => serialize(() => activated(info)),
      windowFocus: (windowId) => serialize(() => focused(windowId)),
      tabRemoved: (tabId) => serialize(() => closed(tabId)),
      idle: () => serialize(() => attentionHeartbeat()),
      bookmarkCreated: bookmarkChanged,
      bookmarkMoved: bookmarkChanged,
      bookmarkChanged,
      bookmarkRemoved: (id, info) => removedBookmark(id, info),
      historyVisited: (item) =>
        serialize(async () => {
          if ((await settings()).autoSyncActive) await queueHistoryItem(item);
        }),
      historyVisitRemoved: (info) => removedHistory(info),
    },
    actions: {
      async ingest_current_tab() {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab) throw new Error("No active tab");
        return captureTab(tab);
      },
      ingest_all_tabs: () =>
        createImport({
          importTabs: true,
          importBookmarks: false,
          importHistory: false,
        }),
      sync_bookmarks: () => createImport(bookmarksOnly),
      sync_history: (request) =>
        createImport({
          importTabs: false,
          importBookmarks: false,
          importHistory: true,
          historyRange: request.range || "24h",
        }),
      run_full_import: (request) => createImport(request.options),
      async reset_sync_state() {
        await chrome.storage.local.set({ initialSyncCompleted: false });
        return { success: true };
      },
    },
    jobs: { "library-import": { step, summary } },
  };
}
