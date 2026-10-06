import { fitCapture } from "./capture-budget.js";
import { settings } from "./settings.js";
import { nextSequence, enqueueRecords, hasRecord } from "./outbox.js";
export async function allowedTab(tab) {
  const config = await settings();
  if (tab.incognito)
    return { allowed: false, reason: "Private browsing excluded" };
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return { allowed: false, reason: "Invalid URL" };
  }
  if (!["http:", "https:"].includes(url.protocol))
    return { allowed: false, reason: "Restricted browser page" };
  const policy = config.capturePolicies?.[config.serverUrl] || {
    excludePatterns: [
      "*mail.google.com*",
      "*accounts.google.com*",
      "*bank*",
      "*login*",
      "*signin*",
    ],
  };
  const domains = [...config.excludeDomains, ...(policy.excludeDomains || [])];
  if (
    domains.some(
      (d) =>
        d.trim() &&
        (url.hostname === d.trim().toLowerCase() ||
          url.hostname.endsWith("." + d.trim().toLowerCase())),
    )
  )
    return { allowed: false, reason: "Excluded domain" };
  for (const pattern of policy.excludePatterns || []) {
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    try {
      if (new RegExp(escaped, "i").test(url.href))
        return { allowed: false, reason: "Excluded URL pattern" };
    } catch {}
  }
  return { allowed: true, config };
}
export async function captureTab(
  tab,
  {
    eventId,
    documentId,
    transitionType = "manual_single",
    recordId = crypto.randomUUID(),
    visitedAt = Date.now(),
  } = {},
) {
  if (await hasRecord(recordId))
    return { success: true, queued: true, title: tab.title, recordId };
  const check = await allowedTab(tab);
  if (!check.allowed)
    return { success: false, skipped: true, reason: check.reason };
  const config = check.config;
  let page;
  try {
    const target = documentId
      ? { tabId: tab.id, documentIds: [documentId] }
      : { tabId: tab.id };
    const result = await chrome.scripting.executeScript({
      target,
      files: ["content.js"],
    });
    page = result[0]?.result;
    if (!page) throw new Error("Page extractor returned no data");
  } catch (error) {
    page = {
      url: tab.url,
      title: tab.title || tab.url,
      textContent: tab.title || tab.url,
      html: "",
      blocks: [],
      links: [],
      images: [],
      extraction: {
        method: "tab-metadata",
        version: "blocks-v1",
        quality: "metadata",
        truncated: false,
        originalChars: 0,
        reasons: [String(error.message || error).slice(0, 300)],
      },
    };
  }
  page.title = (page.title || tab.title || tab.url).slice(0, 2000);
  const current = await chrome.tabs.get(tab.id);
  if (current.url !== page.url || (documentId && page.url !== tab.url))
    return {
      success: false,
      skipped: true,
      reason: "Page changed during capture",
    };
  const after = await allowedTab({ ...tab, url: page.url });
  if (!after.allowed)
    return { success: false, skipped: true, reason: after.reason };
  let group = "";
  try {
    if (tab.groupId >= 0 && chrome.tabGroups) {
      const info = await chrome.tabGroups.get(tab.groupId);
      group = info.title || "";
    }
  } catch {}
  const record = {
    ...page,
    captureOrigin:
      page.extraction.method === "tab-metadata" ? "tab-metadata" : "live-dom",
    type: "page_visit",
    recordId,
    eventId,
    documentId,
    collectorId: config.collectorId,
    browserInstanceId: config.browserInstanceId,
    sequence: await nextSequence(),
    visitedAt,
    capturedAt: Date.now(),
    transitionType,
    recordInSession: false,
    tabId: tab.id,
    windowId: tab.windowId,
    openerTabId: tab.openerTabId,
    incognito: false,
    goal: config.currentGoal || "",
    tabGroup: group,
  };
  const bounded = fitCapture(record);
  await enqueueRecords([bounded], config);
  return {
    success: true,
    queued: true,
    title: record.title,
    recordId,
    quality: bounded.extraction.quality,
  };
}
