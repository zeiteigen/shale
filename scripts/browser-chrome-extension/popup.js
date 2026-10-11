import { validatedEndpoint } from "./settings.js";
const el = (id) => document.getElementById(id);
const social = [
  "x.com",
  "twitter.com",
  "reddit.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "linkedin.com",
  "youtube.com",
];
function feedback(message, error = false) {
  el("feedbackBanner").textContent = message;
  el("feedbackBanner").className =
    `feedback-banner ${error ? "error" : "success"}`;
}
async function command(action, extra = {}) {
  const result = await chrome.runtime.sendMessage({ action, ...extra });
  if (!result?.success)
    throw new Error(result?.error || result?.reason || "Operation failed");
  return result;
}
async function connection() {
  try {
    await command("test_connection");
    el("connectionStatus").className = "status-indicator online";
    el("connectionStatus").querySelector(".status-text").textContent =
      "Connector ready";
  } catch (error) {
    el("connectionStatus").className = "status-indicator offline";
    el("connectionStatus").querySelector(".status-text").textContent =
      "Offline";
    feedback(error.message, true);
  }
}
let loaded = false;
async function refresh() {
  const { status } = await command("get_status"),
    box = status.outbox,
    c = box.counts;
  if (!loaded) {
    el("serverUrlInput").value = status.serverUrl;
    el("excludeDomainsText").value = status.excludeDomains.join("\n");
    el("toggleAutoSync").checked = status.autoSyncActive;
    el("toggleSocialMedia").checked = status.excludeSocialMedia;
    el("goalInput").value = status.currentGoal;
    loaded = true;
  }
  el("sessionId").textContent = status.collectorId.slice(0, 16);
  el("sessionPageCount").textContent = c.pending || 0;
  el("totalIngestedCount").textContent =
    (status.totalIngestedCount || 0) + box.sentCount;
  el("deliverySummary").textContent =
    `${c.pending || 0} captured locally · ${c.received || 0} indexing · ${c.indexed || 0} indexed · ${c.skipped || 0} skipped · ${c.failed || 0} failed · ${c.expired || 0} expired (resubmit). Oldest unsent: ${Math.round(box.oldestUnsentAgeMs / 60000)} min.`;
  el("deliveryError").textContent =
    box.lastError || status.lastCaptureError || "";
  el("onboardingBanner").classList.toggle(
    "hidden",
    status.initialSyncCompleted,
  );
  el("lastSyncLabel").textContent = status.lastSyncTime
    ? `Last receipt: ${new Date(status.lastSyncTime).toLocaleTimeString()}`
    : "No server receipts yet";
  el("importJobs").replaceChildren();
  for (const job of status.imports
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5)) {
    const row = document.createElement("p");
    row.textContent = `Import ${job.state} (${job.stage}): ${job.counts.tabs} tabs, ${job.counts.bookmarks} bookmarks, ${job.counts.history} history, ${job.counts.historyVisits || 0} backfilled visits, ${job.counts.skipped} skipped. ${job.error || job.warnings.join(" ")}`;
    const button = document.createElement("button");
    button.textContent = job.state === "running" ? "Cancel" : "Resume";
    if (["running", "failed", "cancelled"].includes(job.state)) {
      button.addEventListener("click", () =>
        act(() =>
          command(job.state === "running" ? "cancel_import" : "resume_import", {
            id: job.id,
          }),
        ),
      );
      row.append(button);
    }
    el("importJobs").append(row);
  }
}
async function act(work) {
  try {
    const result = await work();
    feedback(
      result?.jobId
        ? "Import queued; progress remains available here."
        : result?.queued
          ? "Captured locally; waiting for indexing."
          : "Saved.",
    );
    await refresh();
  } catch (error) {
    feedback(error.message, true);
  }
}
const actions = {
  btnIngestCurrent: "ingest_current_tab",
  btnIngestAllTabs: "ingest_all_tabs",
  btnSyncHistory: "sync_history",
  btnSyncBookmarks: "sync_bookmarks",
  btnRetryFailed: "retry_failed",
  btnResetSyncState: "reset_sync_state",
};
for (const [id, action] of Object.entries(actions))
  el(id).addEventListener("click", () => act(() => command(action)));
el("btnStartFullImport").addEventListener("click", () =>
  act(() =>
    command("run_full_import", {
      options: {
        importTabs: el("chkImportTabs").checked,
        importBookmarks: el("chkImportBookmarks").checked,
        importHistory: el("chkImportHistory").checked,
        historyRange: el("historyRangeSelect").value,
        includeHistoryVisits: el("chkHistoryVisits").checked,
      },
    }),
  ),
);
el("toggleAutoSync").addEventListener("change", () =>
  act(() =>
    chrome.storage.local.set({ autoSyncActive: el("toggleAutoSync").checked }),
  ),
);
el("toggleSocialMedia").addEventListener("change", () =>
  act(async () => {
    const { excludeDomains = [] } =
      await chrome.storage.local.get("excludeDomains");
    const enabled = el("toggleSocialMedia").checked;
    const domains = enabled
      ? [...new Set([...excludeDomains, ...social])]
      : excludeDomains.filter((d) => !social.includes(d));
    await chrome.storage.local.set({
      excludeDomains: domains,
      excludeSocialMedia: enabled,
    });
    el("excludeDomainsText").value = domains.join("\n");
  }),
);
el("btnSaveUrl").addEventListener("click", () =>
  act(async () => {
    await chrome.storage.local.set({
      serverUrl: validatedEndpoint(el("serverUrlInput").value.trim()),
    });
    await connection();
  }),
);
el("btnSaveGoal").addEventListener("click", () =>
  act(() =>
    chrome.storage.local.set({ currentGoal: el("goalInput").value.trim() }),
  ),
);
el("btnSaveExclusions").addEventListener("click", () =>
  act(() =>
    chrome.storage.local.set({
      excludeDomains: el("excludeDomainsText")
        .value.split("\n")
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    }),
  ),
);
refresh().catch((error) => feedback(error.message, true));
connection();
setInterval(() => refresh().catch(() => {}), 2000);
