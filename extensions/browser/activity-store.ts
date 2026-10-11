import { BrowserProtocolError } from "../../lib/browser-validation";
import { fingerprint } from "./inbox-store";
import type { ShaleSDK } from "@shale/sdk";
import type {
  ActivityEventPayload,
  PageVisitPayload,
} from "../../lib/browser-contract";
import { normalizeUrl } from "./filter";

export function storeActivity(
  sdk: ShaleSDK,
  collectorId: string,
  recordId: string,
  page: ActivityEventPayload | PageVisitPayload,
) {
  if (page.type !== "activity_event" && page.recordInSession === false) return;
  const eventId = page.eventId || recordId;
  const event: ActivityEventPayload =
    page.type === "activity_event"
      ? { ...page, collectorId }
      : {
          type: "activity_event",
          eventId,
          recordId,
          collectorId,
          kind: "navigation",
          url: page.url,
          title: page.title || page.url,
          visitedAt: page.visitedAt ?? Date.now(),
          sequence: page.sequence,
          tabId: page.tabId,
          windowId: page.windowId,
          openerTabId: page.openerTabId,
          documentId: page.documentId,
          browserInstanceId: page.browserInstanceId,
          transitionType: page.transitionType,
          sessionId: page.sessionId,
          goal: page.goal,
          tabGroup: page.tabGroup,
        };
  event.url = normalizeUrl(event.url).cleanUrl;
  const previous = sdk.database
    .query<{ payload: string }, [string, string, string]>(
      "SELECT payload FROM browser_activity WHERE extension_id=? AND collector_id=? AND event_id=?",
    )
    .get(sdk.extensionId, collectorId, eventId);
  if (previous) {
    if (
      page.type === "activity_event" &&
      fingerprint({ ...JSON.parse(previous.payload), recordId: undefined }) !==
        fingerprint({ ...event, recordId: undefined })
    )
      throw new BrowserProtocolError(
        "Activity event ID was reused with different observations",
        409,
      );
    pruneActivity(sdk);
    return;
  }
  pruneActivity(sdk);
  sdk.database
    .query("INSERT INTO browser_activity VALUES(?,?,?,?,?,?)")
    .run(
      sdk.extensionId,
      collectorId,
      eventId,
      event.visitedAt,
      event.sequence ?? event.visitedAt,
      JSON.stringify(event),
    );
}
function pruneActivity(sdk: ShaleSDK): void {
  const retentionCutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  sdk.database.query("DELETE FROM browser_activity WHERE extension_id=? AND occurred_at<?")
    .run(sdk.extensionId, retentionCutoff);
}
export function activityEvents(
  sdk: ShaleSDK,
  collectorId?: string,
  limit = 10000,
): ActivityEventPayload[] {
  return sdk.database
    .query<{ payload: string }, [string, string | null, string | null, number]>(
      `SELECT payload FROM browser_activity
    WHERE extension_id=? AND (? IS NULL OR collector_id=?) ORDER BY occurred_at,sequence,event_id LIMIT ?`,
    )
    .all(sdk.extensionId, collectorId ?? null, collectorId ?? null, limit)
    .map((row) => JSON.parse(row.payload));
}
