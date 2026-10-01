import type { SessionVisitRecord } from "./types";
import { pageEntityName } from "./identity";

/**
 * Generates sequential transition edges between consecutively visited pages in a session.
 */
export function buildSequentialEdges(
  visits: SessionVisitRecord[],
): Array<{
  source: string;
  target: string;
  relation: string;
  weight: number;
  metadata: any;
}> {
  const edges: Array<{
    source: string;
    target: string;
    relation: string;
    weight: number;
    metadata: any;
  }> = [];

  for (let i = 1; i < visits.length; i++) {
    const prev = visits[i - 1];
    const curr = visits[i];
    const sameTab =
      prev.tabId === undefined || curr.tabId === undefined
        ? prev.windowId === undefined ||
          curr.windowId === undefined ||
          prev.windowId === curr.windowId
        : prev.tabId === curr.tabId;
    const openedFromPrevious =
      curr.openerTabId !== undefined && curr.openerTabId === prev.tabId;
    if (
      prev.url &&
      curr.url &&
      prev.url !== curr.url &&
      (sameTab || openedFromPrevious)
    ) {
      edges.push({
        source: pageEntityName(prev.url),
        target: pageEntityName(curr.url),
        relation: "NAVIGATED_TO",
        weight: 0.9,
        metadata: {
          fromUrl: prev.url,
          toUrl: curr.url,
          transitionType: curr.transitionType || "link",
          sequenceIndex: i,
        },
      });
    }
  }

  return edges;
}

