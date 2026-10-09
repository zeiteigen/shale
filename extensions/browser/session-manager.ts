export { buildSequentialEdges } from "./navigation";
import { prepareSession, finalizeSession } from "./session-ingest";
export { prepareSession, finalizeSession } from "./session-ingest";
import { randomUUIDv7 } from "bun";
import type { ShaleSDK } from "@shale/sdk";
import type {
  ActiveSessionState,
  IngestedSessionResult,
  PreparedSessionData,
  SessionSnapshotPayload,
  SessionVisitRecord,
} from "./types";
import type { BrowserExtensionSettings } from "./settings.types";
import { normalizeUrl } from "./filter";
import { buildSequentialEdges } from "./navigation";
import { pageEntityName } from "./identity";

const ACTIVE_SESSION_STATE_KEY = "active_session_state";

/**
 * Retrieves the currently active browsing session from extension state.
 */
export function getActiveSession(sdk: ShaleSDK): ActiveSessionState | null {
  return sdk.state.getJson<ActiveSessionState>(ACTIVE_SESSION_STATE_KEY);
}

/**
 * Saves the active browsing session state.
 */
export function setActiveSession(
  sdk: ShaleSDK,
  session: ActiveSessionState | null,
): void {
  if (session === null) {
    sdk.state.delete(ACTIVE_SESSION_STATE_KEY);
  } else {
    sdk.state.setJson(ACTIVE_SESSION_STATE_KEY, session);
  }
}

/**
 * Commits a synthesized browsing session to the database and knowledge graph.
 */
export async function commitSessionToGraph(
  sdk: ShaleSDK,
  sessionId: string,
  startTime: number,
  endTime: number,
  visits: SessionVisitRecord[],
  settings: Partial<BrowserExtensionSettings>,
): Promise<IngestedSessionResult> {
  return sdk.models.batch(
    () => prepareSession(sdk, sessionId, startTime, endTime, visits, settings),
    (prepared) => finalizeSession(sdk, prepared, settings),
  );
}

/**
 * Records a page visit into the active session, finalizing and starting a new session if idle threshold exceeded.
 */
export async function recordSessionVisit(
  sdk: ShaleSDK,
  visit: SessionVisitRecord,
  explicitSessionId?: string,
  settings: Partial<BrowserExtensionSettings> = {},
  prepareOnly = false,
): Promise<{
  activeSession: ActiveSessionState;
  finalizedSession?: IngestedSessionResult;
  preparedSession?: PreparedSessionData;
  sequentialEdge?: { source: string; target: string };
}> {
  const inactivityMinutes = settings.sessionInactivityMinutes ?? 30;
  const idleThresholdMs = inactivityMinutes * 60 * 1000;
  const now = visit.visitedAt || Date.now();

  let active = getActiveSession(sdk);
  let finalizedResult: IngestedSessionResult | undefined;
  let preparedSession: PreparedSessionData | undefined;

  // Check if existing session needs finalization due to idle timeout or explicit new session ID
  if (active) {
    const isIdle = now - active.lastActivityTime > idleThresholdMs;
    const isDifferentExplicitId =
      explicitSessionId && explicitSessionId !== active.sessionId;

    if (isIdle || isDifferentExplicitId) {
      if (active.visits.length > 0) {
        try {
          if (prepareOnly) {
            preparedSession = await prepareSession(
              sdk,
              active.sessionId,
              active.startTime,
              active.lastActivityTime,
              active.visits,
              settings,
            );
          } else {
            finalizedResult = await commitSessionToGraph(
              sdk,
              active.sessionId,
              active.startTime,
              active.lastActivityTime,
              active.visits,
              settings,
            );
          }
        } catch (err: any) {
          sdk.logger.error(
            `Failed to commit session ${active.sessionId}: ${err?.message || err}`,
          );
          throw err;
        }
      }
      active = null;
    }
  }

  // If no active session, initialize a new one
  if (!active) {
    active = {
      sessionId: explicitSessionId || randomUUIDv7(),
      startTime: now,
      lastActivityTime: now,
      visits: [],
    };
  }

  // Retry identity is the event ID, never the page URL.
  if (
    !visit.eventId ||
    !active.visits.some((existing) => existing.eventId === visit.eventId)
  )
    active.visits.push(visit);
  active.visits.sort(
    (a, b) =>
      a.visitedAt - b.visitedAt || (a.sequence ?? 0) - (b.sequence ?? 0),
  );
  const edges = buildSequentialEdges(active.visits);
  const edge = edges.findLast((edge) =>
    edge.metadata.eventId
      ? edge.metadata.eventId === visit.eventId
      : edge.target === pageEntityName(visit.url),
  );
  const sequentialEdge = edge
    ? { source: edge.source, target: edge.target }
    : undefined;
  active.lastActivityTime = Math.max(active.lastActivityTime, now);
  setActiveSession(sdk, active);

  return {
    activeSession: active,
    finalizedSession: finalizedResult,
    preparedSession,
    sequentialEdge,
  };
}

/**
 * Finalizes the currently active session on demand (e.g. from cron or browser session close).
 */
export async function finalizeActiveSession(
  sdk: ShaleSDK,
  settings: Partial<BrowserExtensionSettings> = {},
): Promise<IngestedSessionResult | null> {
  const active = getActiveSession(sdk);
  if (!active || active.visits.length === 0) {
    setActiveSession(sdk, null);
    return null;
  }

  const result = await commitSessionToGraph(
    sdk,
    active.sessionId,
    active.startTime,
    active.lastActivityTime,
    active.visits,
    settings,
  );

  setActiveSession(sdk, null);
  return result;
}

/**
 * Ingests an explicit session snapshot payload provided directly by the Chrome extension.
 */
export async function prepareSessionSnapshot(
  sdk: ShaleSDK,
  payload: SessionSnapshotPayload,
  settings: Partial<BrowserExtensionSettings> = {},
): Promise<PreparedSessionData | null> {
  if (!payload.pages || payload.pages.length === 0) {
    return null;
  }

  const visits: SessionVisitRecord[] = payload.pages.map((p) => {
    const normalized = normalizeUrl(p.url);
    return {
      url: normalized.isValid ? normalized.cleanUrl : p.url,
      title: p.title,
      domain: normalized.domain,
      visitedAt: p.visitedAt,
      tabId: p.tabId,
      windowId: p.windowId,
      openerTabId: p.openerTabId,
      transitionType: p.transitionType,
    };
  });

  const endTime =
    payload.endTime || visits[visits.length - 1]?.visitedAt || Date.now();

  return prepareSession(
    sdk,
    payload.sessionId,
    payload.startTime,
    endTime,
    visits,
    settings,
  );
}

export function ingestSessionSnapshot(
  sdk: ShaleSDK,
  payload: SessionSnapshotPayload,
  settings: Partial<BrowserExtensionSettings> = {},
): Promise<IngestedSessionResult | null> {
  return sdk.models.batch(
    () => prepareSessionSnapshot(sdk, payload, settings),
    (prepared) =>
      prepared
        ? finalizeSession(sdk, prepared, settings)
        : Promise.resolve(null),
  );
}
