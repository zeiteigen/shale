/**
 * Popup UI Controller for Shale Browser Ingestor.
 */

const SOCIAL_MEDIA_DOMAINS = [
  "x.com",
  "twitter.com",
  "reddit.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "linkedin.com",
  "youtube.com",
];

// Elements
const connectionStatus = document.getElementById("connectionStatus");
const feedbackBanner = document.getElementById("feedbackBanner");
const sessionIdEl = document.getElementById("sessionId");
const sessionPageCountEl = document.getElementById("sessionPageCount");
const totalIngestedCountEl = document.getElementById("totalIngestedCount");
const lastSyncLabel = document.getElementById("lastSyncLabel");

const onboardingBanner = document.getElementById("onboardingBanner");
const btnQuickBootstrap = document.getElementById("btnQuickBootstrap");

const chkImportTabs = document.getElementById("chkImportTabs");
const chkImportBookmarks = document.getElementById("chkImportBookmarks");
const chkImportHistory = document.getElementById("chkImportHistory");
const historyRangeSelect = document.getElementById("historyRangeSelect");
const btnStartFullImport = document.getElementById("btnStartFullImport");
const btnResetSyncState = document.getElementById("btnResetSyncState");

const importProgressBox = document.getElementById("importProgressBox");
const importStatusText = document.getElementById("importStatusText");
const importCountsText = document.getElementById("importCountsText");
const importProgressBar = document.getElementById("importProgressBar");

const btnIngestCurrent = document.getElementById("btnIngestCurrent");
const btnIngestAllTabs = document.getElementById("btnIngestAllTabs");
const btnSyncHistory = document.getElementById("btnSyncHistory");
const btnSyncBookmarks = document.getElementById("btnSyncBookmarks");

const toggleAutoSync = document.getElementById("toggleAutoSync");
const toggleSocialMedia = document.getElementById("toggleSocialMedia");
const serverUrlInput = document.getElementById("serverUrlInput");
const btnSaveUrl = document.getElementById("btnSaveUrl");
const excludeDomainsText = document.getElementById("excludeDomainsText");
const btnSaveExclusions = document.getElementById("btnSaveExclusions");

let feedbackTimer = null;

function showFeedback(message, type = "success") {
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackBanner.textContent = message;
  feedbackBanner.className = `feedback-banner ${type}`;
  feedbackTimer = setTimeout(() => {
    feedbackBanner.className = "feedback-banner hidden";
  }, 4000);
}

function setBtnLoading(btn, isLoading, text) {
  if (isLoading) {
    btn.disabled = true;
    btn.dataset.prevHtml = btn.innerHTML;
    btn.innerHTML = `<span>⏳</span> <span>${text || "Processing..."}</span>`;
  } else {
    btn.disabled = false;
    if (btn.dataset.prevHtml) {
      btn.innerHTML = btn.dataset.prevHtml;
    }
  }
}

async function checkConnection() {
  connectionStatus.className = "status-indicator checking";
  connectionStatus.querySelector(".status-text").textContent = "Connecting...";

  chrome.runtime.sendMessage({ action: "test_connection" }, (response) => {
    if (chrome.runtime.lastError || !response || !response.success) {
      connectionStatus.className = "status-indicator offline";
      connectionStatus.querySelector(".status-text").textContent = "Offline";
    } else {
      connectionStatus.className = "status-indicator online";
      connectionStatus.querySelector(".status-text").textContent = "Connected";
    }
  });
}

async function refreshStatus() {
  chrome.runtime.sendMessage({ action: "get_status" }, (response) => {
    if (chrome.runtime.lastError || !response || !response.success) {
      return;
    }

    const st = response.status;
    serverUrlInput.value = st.serverUrl || "http://localhost:7425/ingest";
    toggleAutoSync.checked = Boolean(st.autoSyncActive);
    toggleSocialMedia.checked = Boolean(st.excludeSocialMedia);

    if (Array.isArray(st.excludeDomains)) {
      excludeDomainsText.value = st.excludeDomains.join("\n");
    }

    if (st.session) {
      sessionIdEl.textContent = st.session.sessionId.slice(0, 16) + "...";
      sessionPageCountEl.textContent = st.session.pageCount || 0;
    }

    totalIngestedCountEl.textContent = st.totalIngestedCount || 0;

    if (st.lastSyncTime) {
      const d = new Date(st.lastSyncTime);
      lastSyncLabel.textContent = `Last sync: ${d.toLocaleTimeString()}`;
    } else {
      lastSyncLabel.textContent = "Last sync: Never";
    }

    // Toggle onboarding card
    if (!st.initialSyncCompleted) {
      onboardingBanner.classList.remove("hidden");
    } else {
      onboardingBanner.classList.add("hidden");
    }
  });

  checkConnection();
}

// Progress listener from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "import_progress") {
    importProgressBox.classList.remove("hidden");
    if (message.status) {
      importStatusText.textContent = message.status;
    }
    if (message.count !== undefined) {
      importCountsText.textContent = `${message.count} items`;
    }
    if (message.stage === "tabs") {
      importProgressBar.style.width = "25%";
    } else if (message.stage === "bookmarks") {
      importProgressBar.style.width = "50%";
    } else if (message.stage === "history") {
      importProgressBar.style.width = "80%";
    }
  }
});

// Full Import Executor
async function executeFullImport(options) {
  importProgressBox.classList.remove("hidden");
  importProgressBar.style.width = "10%";
  importStatusText.textContent = "Starting import...";
  importCountsText.textContent = "0 items";

  setBtnLoading(btnStartFullImport, true, "Importing...");
  if (btnQuickBootstrap) setBtnLoading(btnQuickBootstrap, true, "Importing...");

  chrome.runtime.sendMessage(
    { action: "run_full_import", options },
    (response) => {
      setBtnLoading(btnStartFullImport, false);
      if (btnQuickBootstrap) setBtnLoading(btnQuickBootstrap, false);

      if (chrome.runtime.lastError || !response || !response.success) {
        importStatusText.textContent = "Import incomplete — retry failed sections";
        showFeedback(
          response?.results?.errors?.join(", ") || response?.error || "Import encountered an error",
          "error",
        );
      } else {
        const r = response.results;
        importProgressBar.style.width = "100%";
        importStatusText.textContent = "Import complete!";
        importCountsText.textContent = `${r.tabs} pages · ${r.bookmarks} bookmarks · ${r.history} history`;
        showFeedback(
          `Import complete! (${r.tabs} tabs, ${r.bookmarks} bookmarks, ${r.history} history)`,
          "success",
        );
        refreshStatus();
      }
    },
  );
}

// Quick Bootstrap button in banner
btnQuickBootstrap?.addEventListener("click", () => {
  executeFullImport({
    importTabs: true,
    importBookmarks: true,
    importHistory: true,
    historyRange: "7d",
  });
});

// Manual Full Import button
btnStartFullImport.addEventListener("click", () => {
  const options = {
    importTabs: chkImportTabs.checked,
    importBookmarks: chkImportBookmarks.checked,
    importHistory: chkImportHistory.checked,
    historyRange: historyRangeSelect.value,
  };

  if (!options.importTabs && !options.importBookmarks && !options.importHistory) {
    showFeedback("Please select at least one item to import", "error");
    return;
  }

  executeFullImport(options);
});

// Reset sync state for testing
btnResetSyncState.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "reset_sync_state" }, () => {
    showFeedback("Sync state reset. Ready for initial import testing.", "success");
    importProgressBox.classList.add("hidden");
    importProgressBar.style.width = "0%";
    refreshStatus();
  });
});

// Action Handlers
btnIngestCurrent.addEventListener("click", () => {
  setBtnLoading(btnIngestCurrent, true, "Ingesting...");
  chrome.runtime.sendMessage({ action: "ingest_current_tab" }, (res) => {
    setBtnLoading(btnIngestCurrent, false);
    if (chrome.runtime.lastError || !res || !res.success) {
      showFeedback(res?.reason || "Failed to ingest current tab", "error");
    } else {
      showFeedback(`Ingested: "${res.title}"`, "success");
      refreshStatus();
    }
  });
});

btnIngestAllTabs.addEventListener("click", () => {
  setBtnLoading(btnIngestAllTabs, true, "Ingesting tabs...");
  chrome.runtime.sendMessage({ action: "ingest_all_tabs" }, (res) => {
    setBtnLoading(btnIngestAllTabs, false);
    if (chrome.runtime.lastError || !res || !res.success) {
      showFeedback("Failed to ingest all tabs", "error");
    } else {
      showFeedback(
        `Ingested ${res.ingested} tab(s) (${res.skipped} skipped)`,
        "success",
      );
      refreshStatus();
    }
  });
});

btnSyncHistory.addEventListener("click", () => {
  setBtnLoading(btnSyncHistory, true, "Syncing history...");
  chrome.runtime.sendMessage({ action: "sync_history", range: "24h" }, (res) => {
    setBtnLoading(btnSyncHistory, false);
    if (chrome.runtime.lastError || !res || !res.success) {
      showFeedback("Failed to sync history", "error");
    } else {
      showFeedback(`Synced ${res.syncedCount} history items`, "success");
      refreshStatus();
    }
  });
});

btnSyncBookmarks.addEventListener("click", () => {
  setBtnLoading(btnSyncBookmarks, true, "Syncing bookmarks...");
  chrome.runtime.sendMessage({ action: "sync_bookmarks" }, (res) => {
    setBtnLoading(btnSyncBookmarks, false);
    if (chrome.runtime.lastError || !res || !res.success) {
      showFeedback("Failed to sync bookmarks", "error");
    } else {
      showFeedback(`Synced ${res.syncedCount} bookmarks`, "success");
      refreshStatus();
    }
  });
});

// Settings Handlers
toggleAutoSync.addEventListener("change", async () => {
  await chrome.storage.local.set({ autoSyncActive: toggleAutoSync.checked });
  showFeedback(
    toggleAutoSync.checked
      ? "Live tab auto-sync enabled"
      : "Live tab auto-sync disabled",
    "success",
  );
});

toggleSocialMedia.addEventListener("change", async () => {
  const excludeSocial = toggleSocialMedia.checked;
  const data = await chrome.storage.local.get(["excludeDomains"]);
  let domains = data.excludeDomains || [];

  if (excludeSocial) {
    for (const d of SOCIAL_MEDIA_DOMAINS) {
      if (!domains.includes(d)) domains.push(d);
    }
  } else {
    domains = domains.filter((d) => !SOCIAL_MEDIA_DOMAINS.includes(d));
  }

  await chrome.storage.local.set({
    excludeSocialMedia: excludeSocial,
    excludeDomains: domains,
  });

  excludeDomainsText.value = domains.join("\n");
  showFeedback(
    excludeSocial ? "Social media exclusion enabled" : "Social media exclusion disabled",
    "success",
  );
});

btnSaveUrl.addEventListener("click", async () => {
  const url = serverUrlInput.value.trim();
  if (!url) {
    showFeedback("Server URL cannot be empty", "error");
    return;
  }
  await chrome.storage.local.set({ serverUrl: url });
  showFeedback("Server URL saved", "success");
  checkConnection();
});

btnSaveExclusions.addEventListener("click", async () => {
  const lines = excludeDomainsText.value
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);

  await chrome.storage.local.set({ excludeDomains: lines });
  showFeedback(`Updated ${lines.length} exclusion domain(s)`, "success");
});

// Init on popup load
document.addEventListener("DOMContentLoaded", refreshStatus);
