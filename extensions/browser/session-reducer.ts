import type { ShaleSDK } from "@shale/sdk";
import type { ActivityEventPayload } from "../../lib/browser-contract";
import type { SessionVisitRecord } from "./types";
import type { BrowserExtensionSettings } from "./settings.types";
import { fingerprint } from "./inbox-store";
import { normalizeUrl } from "./filter";

export interface ObservedSession {
  sessionId: string;
  collectorId: string;
  startTime: number;
  endTime: number;
  visits: SessionVisitRecord[];
  activityHash: string;
  boundaryReason: string;
}
/** SQLite windows preserve collector order without loading an unbounded event log. */
export function pendingSessions(
  sdk: ShaleSDK,
  settings: Partial<BrowserExtensionSettings>,
  limit = 3,
): ObservedSession[] {
  const idle = (settings.sessionInactivityMinutes ?? 30) * 60000,
    maxEvents = settings.maxSessionEvents ?? 200;
  const groups = sdk.database
    .query<any, any[]>(
      `
    WITH ordered AS (
      SELECT *,lag(occurred_at) OVER w AS previous_at,lag(json_extract(payload,'$.kind')) OVER w AS previous_kind,
        lag(json_extract(payload,'$.browserInstanceId')) OVER w AS previous_instance
      FROM browser_activity WHERE extension_id=?
      WINDOW w AS (PARTITION BY collector_id ORDER BY occurred_at,sequence,event_id)
    ), marked AS (
      SELECT *,CASE WHEN previous_at IS NULL OR occurred_at-previous_at>? OR previous_kind='session_end'
        OR (previous_instance IS NOT NULL AND previous_instance!=json_extract(payload,'$.browserInstanceId')) THEN 1 ELSE 0 END AS boundary FROM ordered
    ), grouped AS (
      SELECT *,sum(boundary) OVER(PARTITION BY collector_id ORDER BY occurred_at,sequence,event_id) AS group_id FROM marked
    ), numbered AS (
      SELECT *,row_number() OVER(PARTITION BY collector_id,group_id ORDER BY occurred_at,sequence,event_id) AS position FROM grouped
    ), segments AS (
      SELECT collector_id,group_id,CAST((position-1)/? AS INTEGER) AS segment,
        min(occurred_at) AS start_time,max(occurred_at) AS end_time,json_group_array(json(payload) ORDER BY occurred_at,sequence,event_id) AS events,
        json_group_array(event_id ORDER BY occurred_at,sequence,event_id) AS event_ids,count(*) AS event_count
      FROM numbered GROUP BY collector_id,group_id,segment
    ) SELECT * FROM segments WHERE (end_time<? OR event_count>=? OR EXISTS (
      SELECT 1 FROM json_each(events) WHERE json_extract(value,'$.kind')='session_end'
    )) AND NOT EXISTS (SELECT 1 FROM browser_sessions s WHERE s.extension_id=? AND s.collector_id=segments.collector_id AND s.indexed_hash=segments.event_ids)
    AND NOT EXISTS(SELECT 1 FROM browser_sessions s WHERE s.extension_id=? AND s.collector_id=segments.collector_id
      AND s.activity_hash=segments.event_ids AND (s.attempts>=? OR s.next_attempt_at>?))
    ORDER BY end_time,collector_id LIMIT ?
  `,
    )
    .all(
      sdk.extensionId,
      idle,
      maxEvents,
      Date.now() - idle,
      maxEvents,
      sdk.extensionId,
      sdk.extensionId,
      settings.maxJobAttempts ?? 5,
      Date.now(),
      limit,
    );
  const sessions: ObservedSession[] = [];
  for (const group of groups) {
    const events = JSON.parse(group.events) as ActivityEventPayload[];
    const sessionId = fingerprint([group.collector_id, events[0]!.eventId]);
    const activityHash = group.event_ids;
    const stored = sdk.database
      .query<{ indexed_hash: string | null }, [string, string]>(
        "SELECT indexed_hash FROM browser_sessions WHERE extension_id=? AND session_id=?",
      )
      .get(sdk.extensionId, sessionId);
    if (stored?.indexed_hash === activityHash) continue;
    const attention = new Map<
      string,
      { duration: number; attended: boolean }
    >();
    const lastNavigation = new Map<number, ActivityEventPayload>();
    const navigationById = new Map(
      events
        .filter(
          (event) =>
            event.kind === "navigation" || event.kind === "history_backfill",
        )
        .map((event) => [event.eventId, event]),
    );
    for (const event of events) {
      if (
        (event.kind === "navigation" || event.kind === "history_backfill") &&
        event.tabId !== undefined
      )
        lastNavigation.set(event.tabId, event);
      if (
        event.tabId !== undefined &&
        (event.kind === "attention" || event.kind === "activation")
      ) {
        const nav = event.navigationEventId
          ? navigationById.get(event.navigationEventId)
          : lastNavigation.get(event.tabId);
        if (!nav || (event.documentId && nav.documentId !== event.documentId))
          continue;
        const previous = attention.get(nav.eventId) ?? {
          duration: 0,
          attended: false,
        };
        previous.duration += event.durationMs ?? 0;
        previous.attended ||= event.attended !== false;
        attention.set(nav.eventId, previous);
      }
    }
    const visits = events
      .filter(
        (event) =>
          event.kind === "navigation" || event.kind === "history_backfill",
      )
      .map((event) => {
        const norm = normalizeUrl(event.url);
        const info = attention.get(event.eventId);
        const cached = sdk.database
          .query<{ prepared: string }, [string, string, string, string]>(
            `SELECT c.prepared FROM browser_content_cache c
        LEFT JOIN browser_captures capture ON capture.extension_id=c.extension_id AND capture.content_key=c.content_key
        WHERE c.extension_id=? AND json_extract(c.prepared,'$.pageData.cleanUrl')=?
        AND (capture.event_id=? AND capture.collector_id=?) ORDER BY capture.captured_at DESC,c.updated_at DESC LIMIT 1`,
          )
          .get(
            sdk.extensionId,
            norm.cleanUrl,
            event.eventId,
            group.collector_id,
          );
        const page = cached ? JSON.parse(cached.prepared) : null;
        return {
          ...event,
          url: norm.cleanUrl,
          domain: norm.domain,
          attended: info?.attended ?? event.attended ?? false,
          durationMs: info?.duration ?? 0,
          summary: page?.analysis.summary,
          topics: page?.analysis.topics,
        } as SessionVisitRecord;
      });
    if (!visits.length) {
      sdk.database
        .query(
          `INSERT INTO browser_sessions(extension_id,session_id,collector_id,activity_hash,start_time,end_time,boundary_reason,indexed_hash)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(extension_id,session_id) DO UPDATE SET indexed_hash=excluded.indexed_hash`,
        )
        .run(
          sdk.extensionId,
          sessionId,
          group.collector_id,
          activityHash,
          group.start_time,
          group.end_time,
          "no-navigation",
          activityHash,
        );
      continue;
    }
    sessions.push({
      sessionId,
      collectorId: group.collector_id,
      startTime: group.start_time,
      endTime: group.end_time,
      visits,
      activityHash,
      boundaryReason:
        group.event_count >= maxEvents
          ? "size"
          : events.some((x) => x.kind === "session_end")
            ? "explicit"
            : "inactivity",
    });
    if (sessions.length >= limit) break;
  }
  return sessions;
}
