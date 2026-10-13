import { validatedEndpoint } from "./settings.js";
import popupModules from "./modules/popup-registry.js";
const el = (id) => document.getElementById(id);
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
    const result = await command("test_connection");
    const missing = Object.entries(result.modules || {}).filter(
      ([, module]) => !module.available,
    );
    el("connectionStatus").className =
      `status-indicator ${missing.length ? "checking" : "online"}`;
    el("connectionStatus").querySelector(".status-text").textContent =
      missing.length ? "Partly ready" : "Connector ready";
    if (missing.length)
      feedback(missing.map(([, module]) => module.error).join(" "), true);
  } catch (error) {
    el("connectionStatus").className = "status-indicator offline";
    el("connectionStatus").querySelector(".status-text").textContent =
      "Offline";
    feedback(error.message, true);
  }
}
async function act(work) {
  try {
    const result = await work();
    feedback(
      result?.jobId
        ? "Job queued; progress remains available here."
        : result?.queued
          ? "Captured locally; waiting for indexing."
          : result?.message || "Saved.",
    );
    await refresh();
  } catch (error) {
    feedback(error.message, true);
  }
}
const sections = popupModules.map(({ id, render }) => {
  const container = document.createElement("div");
  container.className = "module-section";
  container.dataset.module = id;
  const notice = document.createElement("p");
  notice.className = "module-notice hidden";
  const body = document.createElement("div");
  container.append(notice, body);
  el("modules").append(container);
  const instance = render(body, {
    id,
    // Plain names address this module's own actions.
    command: (action, extra) =>
      command(action.includes(":") ? action : `${id}:${action}`, extra),
    act,
    feedback,
  });
  return { id, container, notice, instance };
});
function renderToggles(status) {
  el("moduleToggles").replaceChildren(
    ...status.modules.map((module) => {
      const row = document.createElement("label");
      row.className = "setting-item toggle-row";
      const text = document.createElement("span");
      text.className = "setting-name";
      text.textContent = `${module.label} capture`;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "toggle-input";
      input.checked = module.enabled;
      input.addEventListener("change", () =>
        act(() =>
          command("set_module_enabled", {
            id: module.id,
            enabled: input.checked,
          }),
        ),
      );
      row.append(text, input);
      return row;
    }),
  );
}
let loaded = false;
async function refresh() {
  const { status } = await command("get_status"),
    box = status.outbox,
    c = box.counts;
  if (!loaded) {
    el("serverUrlInput").value = status.serverUrl;
    renderToggles(status);
    loaded = true;
  }
  el("deliverySummary").textContent =
    `${c.pending || 0} captured locally · ${c.received || 0} indexing · ${c.indexed || 0} indexed · ${c.skipped || 0} skipped · ${c.failed || 0} failed · ${c.expired || 0} expired (resubmit). Oldest unsent: ${Math.round(box.oldestUnsentAgeMs / 60000)} min.`;
  el("deliveryError").textContent =
    box.lastError || status.lastCaptureError || "";
  el("lastSyncLabel").textContent = status.lastSyncTime
    ? `Last receipt: ${new Date(status.lastSyncTime).toLocaleTimeString()}`
    : "No server receipts yet";
  el("jobList").replaceChildren();
  for (const job of status.jobs
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5)) {
    const row = document.createElement("p");
    row.textContent =
      job.summary || `${job.module} ${job.kind} ${job.state}. ${job.error || ""}`;
    if (["running", "failed", "cancelled"].includes(job.state)) {
      const button = document.createElement("button");
      button.textContent = job.state === "running" ? "Cancel" : "Resume";
      button.addEventListener("click", () =>
        act(() =>
          command(job.state === "running" ? "cancel_import" : "resume_import", {
            id: job.id,
          }),
        ),
      );
      row.append(button);
    }
    el("jobList").append(row);
  }
  for (const section of sections) {
    const module = status.modules.find((m) => m.id === section.id);
    const unavailable = module?.connection && !module.connection.available;
    section.container.classList.toggle("disabled", !module?.enabled);
    section.notice.classList.toggle("hidden", !unavailable && module?.enabled);
    section.notice.textContent = !module?.enabled
      ? `${module?.label || section.id} capture is turned off in Settings.`
      : unavailable
        ? module.connection.error
        : "";
    try {
      section.instance?.refresh?.(status, module);
    } catch (error) {
      section.notice.textContent = error.message;
      section.notice.classList.remove("hidden");
    }
  }
}
el("btnRetryFailed").addEventListener("click", () =>
  act(() => command("retry_failed")),
);
el("btnSaveUrl").addEventListener("click", () =>
  act(async () => {
    await chrome.storage.local.set({
      serverUrl: validatedEndpoint(el("serverUrlInput").value.trim()),
    });
    await connection();
  }),
);
refresh().catch((error) => feedback(error.message, true));
connection();
setInterval(() => refresh().catch(() => {}), 2000);
