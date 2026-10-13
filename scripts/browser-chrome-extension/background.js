/**
 * Core service worker: owns Chrome listeners, the outbox, delivery, and jobs, and fans
 * events out to the modules that Shale extensions contribute (see core/module-host.js).
 */
import { readySettings, settings } from "./settings.js";
import { outboxSummary } from "./outbox.js";
import { deliverOutbox, retryFailures, checkConnection } from "./delivery.js";
import { jobs, updateJob } from "./jobs.js";
import { createHost } from "./core/module-host.js";
import registry from "./modules/registry.js";

const host = createHost(registry);
const report = (promise) =>
  Promise.resolve(promise).catch(async (error) => {
    console.warn("Shale browser:", error);
    await chrome.storage.local.set({
      lastCaptureError: error.message || String(error),
    });
  });
/** Call a listener on every enabled module; one module's failure never blocks another. */
async function dispatch(name, ...args) {
  await Promise.all(
    (await host.enabled()).map((module) => {
      const listener = module.definition.listeners?.[name];
      return listener ? report(listener(...args)) : undefined;
    }),
  );
}
const POLICY_REFRESH_MS = 30 * 60000;
const testConnection = async () =>
  checkConnection(
    (await host.enabled()).map((module) => ({
      id: module.id,
      protocolVersion: module.definition.protocol.version,
    })),
  );
/** Server-side settings reach modules through their policies; refresh them periodically. */
async function refreshPolicies() {
  const config = await settings();
  if (Date.now() - (config.moduleStatus?.checkedAt || 0) < POLICY_REFRESH_MS)
    return;
  await testConnection().catch(async (error) => {
    await chrome.storage.local.set({
      lastConnectionError: error.message,
      moduleStatus: { ...config.moduleStatus, checkedAt: Date.now() },
    });
  });
}
async function wake() {
  await readySettings();
  for (const module of await host.enabled())
    if (module.definition.wake) await report(module.definition.wake());
  await host.resumeJobs();
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
    report(refreshPolicies().then(() => dispatch("alarm")).then(wake));
});
chrome.webNavigation.onCommitted.addListener((details) =>
  report(dispatch("navigation", details)),
);
chrome.webNavigation.onHistoryStateUpdated.addListener((details) =>
  report(dispatch("navigation", details)),
);
chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
  const hash = new URL(details.url).hash;
  if (hash.startsWith("#/") || hash.startsWith("#!"))
    report(dispatch("navigation", details));
});
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.status === "complete")
    report(dispatch("tabComplete", id, tab).then(deliverOutbox));
});
chrome.tabs.onActivated.addListener((info) =>
  report(dispatch("tabActivated", info)),
);
chrome.windows.onFocusChanged.addListener((id) =>
  report(dispatch("windowFocus", id)),
);
chrome.tabs.onRemoved.addListener((id) => report(dispatch("tabRemoved", id)));
chrome.idle.onStateChanged.addListener((state) =>
  report(dispatch("idle", state)),
);
chrome.bookmarks.onCreated.addListener((...args) =>
  report(dispatch("bookmarkCreated", ...args)),
);
chrome.bookmarks.onMoved.addListener((...args) =>
  report(dispatch("bookmarkMoved", ...args)),
);
chrome.bookmarks.onChanged.addListener((...args) =>
  report(dispatch("bookmarkChanged", ...args)),
);
chrome.bookmarks.onRemoved.addListener((...args) =>
  report(dispatch("bookmarkRemoved", ...args)),
);
chrome.history.onVisited.addListener((item) =>
  report(dispatch("historyVisited", item)),
);
chrome.history.onVisitRemoved.addListener((info) =>
  report(dispatch("historyVisitRemoved", info)),
);

const JOB_FIELDS = [
  "id",
  "module",
  "kind",
  "state",
  "stage",
  "counts",
  "warnings",
  "error",
  "summary",
  "createdAt",
  "updatedAt",
];
async function status() {
  const config = await settings();
  const modules = [];
  for (const module of host.modules) {
    let moduleStatus;
    try {
      moduleStatus = await module.definition.status?.();
    } catch (error) {
      moduleStatus = { error: error.message };
    }
    modules.push({
      id: module.id,
      label: module.label,
      enabled: config.modules?.[module.id] !== false,
      connection: config.moduleStatus?.modules?.[module.id],
      status: moduleStatus,
    });
  }
  return {
    ...config,
    outbox: await outboxSummary(),
    jobs: (await jobs()).map((job) =>
      Object.fromEntries(JOB_FIELDS.map((field) => [field, job[field]])),
    ),
    modules,
  };
}
/** `<module>:<action>` messages go to that module; plain actions are the core's. */
async function moduleAction(request) {
  const [id, name] = request.action.split(/:(.*)/s);
  const module = host.get(id);
  const action = module?.definition.actions?.[name];
  if (!action) throw new Error("Unknown action");
  if (!(await module.runtime.enabled()))
    throw new Error(`${module.label} capture is turned off`);
  const result = await action(request);
  report(host.resumeJobs().then(deliverOutbox));
  return result;
}
chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  (async () => {
    if (String(request.action).includes(":")) return moduleAction(request);
    switch (request.action) {
      case "get_status":
        return { success: true, status: await status() };
      case "test_connection":
        return testConnection();
      case "retry_failed":
        await retryFailures();
        report(deliverOutbox());
        return { success: true };
      case "cancel_import":
      case "resume_import":
        await updateJob(
          request.id,
          request.action === "cancel_import" ? "cancel" : "resume",
        );
        report(host.resumeJobs());
        return { success: true };
      case "set_module_enabled": {
        if (!host.get(request.id)) throw new Error("Unknown module");
        const config = await settings();
        await chrome.storage.local.set({
          modules: { ...config.modules, [request.id]: !!request.enabled },
        });
        return { success: true };
      }
      default:
        throw new Error("Unknown action");
    }
  })().then(respond, (error) =>
    respond({ success: false, error: error.message }),
  );
  return true;
});
report(initialize());
