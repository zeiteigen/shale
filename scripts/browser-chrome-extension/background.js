/**
 * Background Service Worker for Shale Browser Ingestor (Manifest V3).
 */

const DEFAULT_SERVER_URL = "http://localhost:7425/ingest";
const DEFAULT_EXCLUDE_DOMAINS = [
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
];

// Helper to generate a UUID v4
function generateUUID() {
  if (crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "sess_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9);
}

const SESSION_STORAGE_KEY = "currentBrowserSession";
let currentSession = null;

async function loadCurrentSession() {
  if (currentSession) return currentSession;
  const stored = await chrome.storage.local.get([SESSION_STORAGE_KEY]);
  currentSession = stored[SESSION_STORAGE_KEY] || {
    sessionId: generateUUID(),
    startTime: Date.now(),
    lastActivityTime: Date.now(),
    pageCount: 0,
  };
  return currentSession;
}

async function saveCurrentSession() {
  await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: currentSession });
}

// Initialize settings on install
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get([
    "serverUrl",
    "autoSyncActive",
    "excludeSocialMedia",
    "excludeDomains",
    "sessionIdleMinutes",
  ]);

  const defaults = {
    serverUrl: DEFAULT_SERVER_URL,
    autoSyncActive: true,
    excludeSocialMedia: true,
    excludeDomains: DEFAULT_EXCLUDE_DOMAINS,
    sessionIdleMinutes: 30,
    totalIngestedCount: 0,
    initialSyncCompleted: false,
  };
  const missingDefaults = Object.fromEntries(
    Object.entries(defaults).filter(([key]) => stored[key] === undefined),
  );
  if (Object.keys(missingDefaults).length) {
    await chrome.storage.local.set(missingDefaults);
  }

  // Set up periodic session check alarm
  chrome.alarms.create("session_heartbeat", { periodInMinutes: 5 });
});

// Rotate a session after real inactivity. Heartbeats must never count as user
// activity, otherwise a five-minute alarm keeps every session alive forever.
async function getOrUpdateSession(markActivity = true) {
  const settings = await chrome.storage.local.get(["sessionIdleMinutes"]);
  const idleThresholdMs = (settings.sessionIdleMinutes || 30) * 60 * 1000;
  const now = Date.now();
  await loadCurrentSession();

  if (now - currentSession.lastActivityTime > idleThresholdMs) {
    currentSession = {
      sessionId: generateUUID(),
      startTime: now,
      lastActivityTime: now,
      pageCount: 0,
    };
  } else if (markActivity) {
    currentSession.lastActivityTime = now;
  }

  await saveCurrentSession();
  return currentSession;
}

// Check if a URL is excluded by domain rules or non-web protocols
async function isUrlExcluded(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { excluded: true, reason: "Non-HTTP protocol" };
    }

    const host = parsed.hostname.toLowerCase();
    const settings = await chrome.storage.local.get([
      "excludeDomains",
      "excludeSocialMedia",
    ]);

    const domains = settings.excludeDomains || DEFAULT_EXCLUDE_DOMAINS;
    for (const d of domains) {
      const cleanD = d.trim().toLowerCase();
      if (cleanD && (host === cleanD || host.endsWith("." + cleanD))) {
        return { excluded: true, reason: `Matches excluded domain "${cleanD}"` };
      }
    }

    return { excluded: false, domain: host };
  } catch {
    return { excluded: true, reason: "Malformed URL" };
  }
}

// Sends an IngestMaterial payload to the Shale server
async function postToShale(payload) {
  const settings = await chrome.storage.local.get(["serverUrl"]);
  const serverUrl = settings.serverUrl || DEFAULT_SERVER_URL;

  const body = {
    target_processor: "browser",
    content: JSON.stringify(payload),
    metadata: {
      connector: "chrome-extension",
      data_origin: "chrome",
      time: Date.now(),
    },
  };

  const response = await fetch(serverUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Server returned HTTP ${response.status}`);
  }

  const itemCount = payload.type === "tabs_batch"
    ? payload.pages?.length || 0
    : payload.type === "history_batch" || payload.type === "bookmarks_batch"
      ? payload.items?.length || 0
      : 1;

  // Increment by records sent, not by HTTP requests/batches.
  const data = await chrome.storage.local.get(["totalIngestedCount"]);
  await chrome.storage.local.set({
    totalIngestedCount: (data.totalIngestedCount || 0) + itemCount,
    lastSyncTime: Date.now(),
  });

  return await response.text();
}

// Extracts clean page data from a tab
async function extractPageDataFromTab(tab, transitionType = "active_page") {
  if (!tab.url) return null;

  const check = await isUrlExcluded(tab.url);
  if (check.excluded) {
    return null;
  }

  const recordInSession = transitionType === "navigation";
  const session = recordInSession ? await getOrUpdateSession(true) : null;

  let pageData = {
    url: tab.url,
    title: tab.title || tab.url,
    textContent: tab.title || tab.url,
    excerpt: "",
    favIconUrl: tab.favIconUrl || "",
    author: "",
    html: "",
    links: [],
    images: [],
  };

  // Try extracting rich DOM text content via scripting
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });

    if (results && results[0] && results[0].result) {
      pageData = Object.assign(pageData, results[0].result);
    }
  } catch (err) {
    // If scripting fails (e.g. on chrome web store or restricted pages), fall back to tab metadata
  }

  return {
    type: "page_visit",
    url: pageData.url,
    title: pageData.title,
    textContent: pageData.textContent,
    excerpt: pageData.excerpt,
    favIconUrl: pageData.favIconUrl,
    author: pageData.author,
    html: pageData.html,
    links: pageData.links,
    images: pageData.images,
    tabId: tab.id,
    windowId: tab.windowId,
    openerTabId: tab.openerTabId,
    transitionType,
    recordInSession,
    sessionId: session?.sessionId,
    visitedAt: Date.now(),
  };
}

// Ingest a specific single tab's content
async function ingestTab(tab, transitionType = "active_page") {
  const payload = await extractPageDataFromTab(tab, transitionType);
  if (!payload) return { success: false, reason: "Excluded or invalid URL" };

  await postToShale(payload);
  if (payload.recordInSession) {
    currentSession.pageCount++;
    await saveCurrentSession();
  }

  return { success: true, url: tab.url, title: payload.title };
}

// Observe active tab navigation and updates
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    const settings = await chrome.storage.local.get(["autoSyncActive"]);
    if (settings.autoSyncActive) {
      try {
        await ingestTab(tab, "navigation");
      } catch (err) {
        console.warn("Auto-sync tab error:", err);
      }
    }
  }
});

// Periodic alarm listener for session idle check
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "session_heartbeat") {
    await getOrUpdateSession(false);
  }
});

// History Sync function (supports ranges: "24h", "7d", "30d", "90d", "all")
async function syncHistoryPaginated(range = "24h") {
  const now = Date.now();
  let startTime = 0;

  switch (range) {
    case "24h":
      startTime = now - 24 * 60 * 60 * 1000;
      break;
    case "7d":
      startTime = now - 7 * 24 * 60 * 60 * 1000;
      break;
    case "30d":
      startTime = now - 30 * 24 * 60 * 60 * 1000;
      break;
    case "90d":
      startTime = now - 90 * 24 * 60 * 60 * 1000;
      break;
    case "all":
      startTime = 0;
      break;
    default:
      if (typeof range === "number") {
        startTime = now - range * 60 * 60 * 1000;
      } else {
        startTime = now - 24 * 60 * 60 * 1000;
      }
  }

  const batchSize = 250;
  const maxTotalItems = range === "all" ? 25000 : 5000;
  let currentEndTime = now;
  let totalSynced = 0;
  let hasMore = true;

  while (hasMore && totalSynced < maxTotalItems) {
    const items = await chrome.history.search({
      text: "",
      startTime,
      endTime: currentEndTime,
      maxResults: batchSize,
    });

    if (!items || items.length === 0) {
      break;
    }

    const validItems = [];
    let minVisitTime = currentEndTime;

    for (const item of items) {
      if (!item.url) continue;

      if (item.lastVisitTime && item.lastVisitTime < minVisitTime) {
        minVisitTime = item.lastVisitTime;
      }

      const check = await isUrlExcluded(item.url);
      if (!check.excluded) {
        validItems.push({
          url: item.url,
          title: item.title || item.url,
          visitTime: item.lastVisitTime || now,
          visitCount: item.visitCount,
          typedCount: item.typedCount,
        });
      }
    }

    if (validItems.length > 0) {
      await postToShale({
        type: "history_batch",
        items: validItems,
        syncedAt: Date.now(),
      });
      totalSynced += validItems.length;

      // Broadcast progress
      try {
        await chrome.runtime.sendMessage({
          action: "import_progress",
          stage: "history",
          count: totalSynced,
        });
      } catch {}
    }

    // Stop if last page or reached time boundary
    if (
      items.length < batchSize ||
      minVisitTime <= startTime ||
      minVisitTime >= currentEndTime
    ) {
      hasMore = false;
    } else {
      currentEndTime = minVisitTime - 1;
    }
  }

  return { syncedCount: totalSynced };
}

// Full Initial & On-Demand Import Workflow
async function runFullImport(options = {}) {
  const {
    importTabs = true,
    importBookmarks = true,
    importHistory = true,
    historyRange = "7d",
  } = options;

  const results = {
    tabs: 0,
    bookmarks: 0,
    history: 0,
    errors: [],
  };

  // 1. Ingest Open Tabs
  if (importTabs) {
    try {
      try {
        await chrome.runtime.sendMessage({
          action: "import_progress",
          stage: "tabs",
          status: "Importing open tabs...",
        });
      } catch {}
      const tabRes = await syncAllOpenTabs();
      results.tabs = tabRes.ingested;
    } catch (err) {
      results.errors.push(`Tabs import error: ${err.message}`);
    }
  }

  // 2. Ingest Bookmarks
  if (importBookmarks) {
    try {
      try {
        await chrome.runtime.sendMessage({
          action: "import_progress",
          stage: "bookmarks",
          status: "Importing bookmarks...",
        });
      } catch {}
      const bmRes = await syncBookmarks();
      results.bookmarks = bmRes.syncedCount;
    } catch (err) {
      results.errors.push(`Bookmarks import error: ${err.message}`);
    }
  }

  // 3. Ingest History (Paginated)
  if (importHistory) {
    try {
      try {
        await chrome.runtime.sendMessage({
          action: "import_progress",
          stage: "history",
          status: `Importing history (${historyRange})...`,
        });
      } catch {}
      const histRes = await syncHistoryPaginated(historyRange);
      results.history = histRes.syncedCount;
    } catch (err) {
      results.errors.push(`History import error: ${err.message}`);
    }
  }

  // Only mark onboarding complete when every selected stage succeeded. A partial
  // import remains visible and can be retried instead of appearing successful.
  await chrome.storage.local.set({
    initialSyncCompleted: results.errors.length === 0,
    lastFullImportTime: Date.now(),
    lastFullImportResults: results,
  });

  return results;
}

// Reset sync state for re-importing or manual testing
async function resetSyncState() {
  await chrome.storage.local.set({
    initialSyncCompleted: false,
    lastFullImportTime: null,
    lastFullImportResults: null,
  });
  return { success: true };
}

// Bookmarks Sync function
async function syncBookmarks() {
  const tree = await chrome.bookmarks.getTree();
  const bookmarkItems = [];

  function walk(nodes, folderPath = "") {
    for (const node of nodes) {
      if (node.url) {
        bookmarkItems.push({
          id: node.id,
          title: node.title || node.url,
          url: node.url,
          folderPath: folderPath || "Bookmarks Bar",
          dateAdded: node.dateAdded || Date.now(),
        });
      }
      if (node.children && node.children.length > 0) {
        const nextFolder = folderPath
          ? `${folderPath} / ${node.title}`
          : node.title;
        walk(node.children, nextFolder);
      }
    }
  }

  walk(tree);

  const validItems = [];
  for (const item of bookmarkItems) {
    const check = await isUrlExcluded(item.url);
    if (!check.excluded) {
      validItems.push(item);
    }
  }

  if (validItems.length > 0) {
    await postToShale({
      type: "bookmarks_batch",
      items: validItems,
      syncedAt: Date.now(),
    });
  }

  return { syncedCount: validItems.length };
}

// Sync all currently open tabs as a batch (two-phase local GPU pipeline)
async function syncAllOpenTabs() {
  const tabs = await chrome.tabs.query({});
  const validPages = [];
  let skipped = 0;

  for (const tab of tabs) {
    try {
      const page = await extractPageDataFromTab(tab, "batch_open_tabs");
      if (page) {
        validPages.push(page);
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }

  if (validPages.length > 0) {
    await postToShale({
      type: "tabs_batch",
      pages: validPages,
      syncedAt: Date.now(),
    });
  }

  return { ingested: validPages.length, skipped };
}

// Message Dispatcher from Popup UI
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  (async () => {
    try {
      switch (request.action) {
        case "get_status": {
          await loadCurrentSession();
          const stored = await chrome.storage.local.get([
            "serverUrl",
            "autoSyncActive",
            "excludeSocialMedia",
            "excludeDomains",
            "totalIngestedCount",
            "lastSyncTime",
            "sessionIdleMinutes",
            "initialSyncCompleted",
            "lastFullImportTime",
            "lastFullImportResults",
          ]);
          sendResponse({
            success: true,
            status: {
              ...stored,
              session: currentSession,
            },
          });
          break;
        }

        case "test_connection": {
          const settings = await chrome.storage.local.get(["serverUrl"]);
          const url = settings.serverUrl || DEFAULT_SERVER_URL;
          try {
            const healthUrl = new URL("/health", url).toString();
            const res = await fetch(healthUrl, { method: "GET" });
            sendResponse({ success: res.ok, status: res.status });
          } catch (err) {
            sendResponse({ success: false, error: err.message });
          }
          break;
        }

        case "ingest_current_tab": {
          const [activeTab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          if (!activeTab) {
            sendResponse({ success: false, error: "No active tab found" });
            return;
          }
          const res = await ingestTab(activeTab, "manual_single");
          sendResponse(res);
          break;
        }

        case "ingest_all_tabs": {
          const res = await syncAllOpenTabs();
          sendResponse({ success: true, ...res });
          break;
        }

        case "sync_history": {
          const res = await syncHistoryPaginated(request.range || request.hours || "24h");
          sendResponse({ success: true, ...res });
          break;
        }

        case "sync_bookmarks": {
          const res = await syncBookmarks();
          sendResponse({ success: true, ...res });
          break;
        }

        case "run_full_import": {
          const res = await runFullImport(request.options || {});
          sendResponse({ success: res.errors.length === 0, results: res });
          break;
        }

        case "reset_sync_state": {
          const res = await resetSyncState();
          sendResponse(res);
          break;
        }

        default:
          sendResponse({ success: false, error: "Unknown action" });
      }
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Keep message channel open for async response
});
