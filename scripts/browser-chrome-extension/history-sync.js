import { allowedTab } from "./capture.js";
import { settings } from "./settings.js";
import { enqueueRecords, nextSequence, hasRecord } from "./outbox.js";
const DAY = 86400000;
export function historyWindows(range) {
  const now = Date.now(),
    days = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, all: now / DAY };
  if (!(range in days)) throw new Error("Unsupported history range");
  return [
    { start: Math.max(0, Math.floor(now - days[range] * DAY)), end: now },
  ];
}
// Bisect saturated time windows instead of dropping timestamp ties with minTime - 1.
export async function historyStep(job) {
  if (job.pendingVisits?.length) {
    const visit = job.pendingVisits[0],
      id = `history-visit:${visit.visitId}`;
    if (!(await hasRecord(id))) {
      const config = await settings();
      const record = {
        type: "activity_event",
        recordId: id,
        eventId: id,
        kind: "history_backfill",
        collectorId: config.collectorId,
        url: job.backfillPage.url,
        title: job.backfillPage.title || job.backfillPage.url,
        visitedAt: Math.round(visit.visitTime),
        sequence: await nextSequence(),
        transitionType: visit.transition || "history",
        attended: false,
      };
      if ((await allowedTab({ url: record.url })).allowed)
        await enqueueRecords([record], config);
    }
    job.pendingVisits.shift();
    job.counts.historyVisits = (job.counts.historyVisits || 0) + 1;
    return false;
  }
  if (job.historyItems?.length) {
    const item = job.historyItems[0];
    if (await queueHistoryItem(item)) {
      if (job.options?.includeHistoryVisits) {
        const bounds = job.historyBounds;
        const visits = (await chrome.history.getVisits({ url: item.url }))
          .filter(
            (visit) =>
              visit.visitTime >= bounds.start && visit.visitTime <= bounds.end,
          )
          .sort((a, b) => a.visitTime - b.visitTime);
        if (visits.length > 500) {
          job.incomplete = true;
          job.warnings.push(
            `Visit backfill limited to 500 records for ${item.url}`,
          );
        }
        job.pendingVisits = visits.slice(0, 500);
        job.backfillPage = { url: item.url, title: item.title };
      }
      job.counts.history++;
    }
    job.historyItems.shift();
    return false;
  }
  if (!job.historyWindows.length) return true;
  const window = job.historyWindows.at(-1),
    limit = 10000;
  const items = await chrome.history.search({
    text: "",
    startTime: window.start,
    endTime: window.end,
    maxResults: limit,
  });
  job.historyWindows.pop();
  if (items.length === limit) {
    if (window.end - window.start > 1) {
      const mid = Math.floor((window.start + window.end) / 2);
      job.historyWindows.push(
        { start: mid, end: window.end },
        { start: window.start, end: mid },
      );
      return false;
    }
    job.incomplete = true;
    job.warnings.push(
      "History API saturated at a single timestamp; this range cannot be enumerated completely.",
    );
  }
  job.historyItems = items;
  return false;
}
export async function removedHistory(info) {
  const config = await settings();
  const urls = info.urls || [];
  for (let i = 0; i < Math.max(1, urls.length); i += 100)
    await enqueueRecords(
      [
        {
          type: "catalog_delete",
          catalog: "history",
          recordId: crypto.randomUUID(),
          sequence: await nextSequence(),
          all: info.allHistory,
          urls: urls.slice(i, i + 100),
        },
      ],
      config,
    );
}

export async function queueHistoryItem(item) {
  if (!item.url || !(await allowedTab({ url: item.url })).allowed) return false;
  const config = await settings();
  const record = {
    type: "history_item",
    collectorId: config.collectorId,
    id: item.id,
    url: item.url,
    title: item.title || item.url,
    visitTime: Math.round(item.lastVisitTime || 0),
    visitCount: item.visitCount,
    typedCount: item.typedCount,
  };
  const hash = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(record)),
      ),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  await enqueueRecords(
    [{ ...record, recordId: `history:${item.id}:${hash}` }],
    config,
  );
  return true;
}
