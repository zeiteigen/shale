import { settings } from "./settings.js";
import { allowedTab, captureTab } from "./capture.js";
import { enqueueRecords, nextSequence } from "./outbox.js";
// Small document/attention state survives worker restarts without persisting page text.
let queue = Promise.resolve();
export function serialize(work) {
  const next = queue.then(work);
  queue = next.catch((error) => console.warn("Browser activity:", error));
  return next;
}
async function emit(tab, kind, extra = {}) {
  const check = await allowedTab(tab);
  if (!check.allowed) return null;
  let tabGroup = "";
  try {
    if (tab.groupId >= 0)
      tabGroup = (await chrome.tabGroups.get(tab.groupId)).title || "";
  } catch {}
  const config = check.config,
    eventId = extra.eventId || crypto.randomUUID();
  await enqueueRecords(
    [
      {
        type: "activity_event",
        recordId: eventId,
        eventId,
        collectorId: config.collectorId,
        browserInstanceId: config.browserInstanceId,
        kind,
        tabGroup,
        url: tab.url,
        title: tab.title || tab.url,
        tabId: tab.id,
        windowId: tab.windowId,
        openerTabId: tab.openerTabId,
        incognito: false,
        visitedAt: Date.now(),
        sequence: await nextSequence(),
        goal: config.currentGoal || "",
        ...extra,
      },
    ],
    config,
  );
  return eventId;
}
export async function navigation(details) {
  if (details.frameId !== 0) return;
  const config = await settings();
  if (!config.autoSyncActive) return;
  const tab = await chrome.tabs.get(details.tabId);
  if (!(await allowedTab({ ...tab, url: details.url })).allowed) return;
  const { attention } = await chrome.storage.session.get("attention");
  if (attention?.tab.id === tab.id) await endAttention();
  const eventId = crypto.randomUUID(),
    visitedAt = Math.round(details.timeStamp);
  const saved = await chrome.storage.session.get("documents"),
    documents = saved.documents || {};
  const recordId = `capture:${eventId}`;
  // Persist capture intent before emitting activity so a worker restart can resume extraction.
  documents[tab.id] = {
    eventId,
    recordId,
    documentId: details.documentId,
    windowId: tab.windowId,
    url: details.url,
    visitedAt,
    pending: true,
  };
  await chrome.storage.session.set({ documents });
  await emit({ ...tab, url: details.url }, "navigation", {
    eventId,
    documentId: details.documentId,
    windowId: tab.windowId,
    visitedAt,
    transitionType: details.transitionType || "spa",
  });
  if (tab.active) await startAttention(tab);
  if (details.transitionType === undefined) await capturePending(tab.id);
}
export async function capturePending(tabId) {
  const { documents = {} } = await chrome.storage.session.get("documents");
  const doc = documents[tabId];
  if (!doc?.pending) return;
  const tab = await chrome.tabs.get(Number(tabId));
  if (tab.url !== doc.url) {
    delete documents[tabId];
    await chrome.storage.session.set({ documents });
    return;
  }
  const result = await captureTab(tab, {
    ...doc,
    transitionType: "navigation",
  });
  if (result.success || result.skipped) {
    const latest = await chrome.storage.session.get("documents");
    if (latest.documents?.[tabId]?.eventId === doc.eventId) {
      latest.documents[tabId].pending = false;
      await chrome.storage.session.set({ documents: latest.documents });
    }
  }
}
export async function resumeCaptures() {
  const { documents = {} } = await chrome.storage.session.get("documents");
  for (const id of Object.keys(documents).slice(0, 20)) {
    try {
      await capturePending(id);
    } catch {}
  }
}
export async function endAttention() {
  const { attention } = await chrome.storage.session.get("attention");
  if (!attention) return;
  const endedAt = Date.now(),
    durationMs = Math.max(0, Math.min(60000, endedAt - attention.startedAt));
  await emit(attention.tab, "attention", {
    eventId: attention.id,
    documentId: attention.documentId,
    navigationEventId: attention.navigationEventId,
    visitedAt: endedAt,
    durationMs,
    attended: true,
  });
  await chrome.storage.session.remove("attention");
}
export async function startAttention(tab) {
  if (!(await allowedTab(tab)).allowed) return;
  if (!tab.active || !(await chrome.windows.get(tab.windowId)).focused) return;
  const { documents = {} } = await chrome.storage.session.get("documents");
  await chrome.storage.session.set({
    attention: {
      id: crypto.randomUUID(),
      tab,
      documentId: documents[tab.id]?.documentId,
      navigationEventId: documents[tab.id]?.eventId,
      startedAt: Date.now(),
    },
  });
}
export async function activated(info) {
  await endAttention();
  const config = await settings();
  if (!config.autoSyncActive) return;
  const tab = await chrome.tabs.get(info.tabId);
  await emit(tab, "activation");
  await startAttention(tab);
}
export async function focused(windowId) {
  await endAttention();
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const config = await settings();
  if (!config.autoSyncActive) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) await startAttention(tab);
}
export async function attentionHeartbeat() {
  const config = await settings();
  if (!config.autoSyncActive) {
    await endAttention();
    return;
  }
  const idle = await chrome.idle.queryState(60);
  const window = await chrome.windows.getLastFocused();
  await endAttention();
  if (idle !== "active" || !window.focused) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId: window.id });
  if (tab) await startAttention(tab);
}
export async function closed(tabId) {
  const { attention, documents = {} } = await chrome.storage.session.get([
    "attention",
    "documents",
  ]);
  if (attention?.tab.id === tabId) await endAttention();
  const doc = documents[tabId];
  if (doc) {
    await emit(
      { id: tabId, url: doc.url, title: doc.url, windowId: doc.windowId },
      "close",
      {
        documentId: doc.documentId,
      },
    );
    delete documents[tabId];
    await chrome.storage.session.set({ documents });
  }
}
