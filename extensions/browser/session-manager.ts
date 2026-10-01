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
 * Commits a synthesized browsing session to the database, vector index, and knowledge graph.
 * Enforces two-phase execution: prepareSession (Phase 1 Chat) -> finalizeSession (Phase 2 Embed).
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

  // Previous visit for sequential navigation linkage
  let sequentialEdge: { source: string; target: string } | undefined;
  if (active.visits.length > 0) {
    const prev = active.visits[active.visits.length - 1];
    const sameTab =
      prev.tabId === undefined || visit.tabId === undefined
        ? prev.windowId === undefined ||
          visit.windowId === undefined ||
          prev.windowId === visit.windowId
        : prev.tabId === visit.tabId;
    const openedFromPrevious =
      visit.openerTabId !== undefined && visit.openerTabId === prev.tabId;
    if (prev.url !== visit.url && (sameTab || openedFromPrevious)) {
      sequentialEdge = {
        source: pageEntityName(prev.url),
        target: pageEntityName(visit.url),
      };
    }
  }

  // Repeated capture events for the same tab and URL update the visit instead
  // of creating artificial self-navigation and bloated session narratives.
  const duplicateIndex = active.visits.findIndex(
    (existing) => existing.url === visit.url && existing.tabId === visit.tabId,
  );
  if (duplicateIndex >= 0) active.visits[duplicateIndex] = visit;
  else active.visits.push(visit);
  active.lastActivityTime = now;
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
