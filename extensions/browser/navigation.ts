import type { SessionVisitRecord } from "./types";
import { pageEntityName } from "./identity";
/** Reconstruct each tab's trail in observed order; tab interleaving is not navigation. */
export function buildSequentialEdges(visits: SessionVisitRecord[]) {
  const last = new Map<string, SessionVisitRecord>();
  const edges: Array<{
    source: string;
    target: string;
    relation: string;
    weight: number;
    metadata: any;
  }> = [];
  const ordered = [...visits].sort(
    (a, b) =>
      a.visitedAt - b.visitedAt || (a.sequence ?? 0) - (b.sequence ?? 0),
  );
  for (const [i, curr] of ordered.entries()) {
    if (
      curr.kind === "history_backfill" ||
      (curr.collectorId &&
        curr.tabId === undefined &&
        curr.openerTabId === undefined)
    )
      continue;
    const scope = `${curr.collectorId ?? "legacy"}:${curr.browserInstanceId ?? "legacy"}`;
    const key = `${scope}:${curr.tabId === undefined ? `window:${curr.windowId ?? ""}` : curr.tabId}`;
    const prev =
      last.get(key) ??
      (curr.openerTabId === undefined
        ? undefined
        : last.get(`${scope}:${curr.openerTabId}`));
    if (prev && prev.url !== curr.url && curr.transitionType !== "activation")
      edges.push({
        source: pageEntityName(prev.url),
        target: pageEntityName(curr.url),
        relation: "NAVIGATED_TO",
        weight: 0.9,
        metadata: {
          fromUrl: prev.url,
          toUrl: curr.url,
          transitionType: curr.transitionType || "unknown",
          sequenceIndex: i,
          eventId: curr.eventId ?? "",
          fromEventId: prev.eventId ?? "",
        },
      });
    last.set(key, curr);
  }
  return edges;
}
