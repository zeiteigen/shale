import { randomUUIDv7 } from "bun";
import type { ShaleSDK } from "@shale/sdk";
import type {
  ActiveSessionState,
  IngestedSessionResult,
  SessionSnapshotPayload,
  SessionVisitRecord,
} from "./types";
import type { BrowserExtensionSettings } from "./settings.types";
import { synthesizeSessionWithLLM } from "./llm-enricher";

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
 * Generates sequential transition edges between consecutively visited pages in a session.
 */
export function buildSequentialEdges(
  visits: SessionVisitRecord[],
): Array<{ source: string; target: string; relation: string; weight: number; metadata: any }> {
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
    if (prev.title && curr.title && prev.title !== curr.title) {
      edges.push({
        source: prev.title,
        target: curr.title,
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

/**
 * Commits a synthesized browsing session to the database, vector index, and knowledge graph.
 */
/**
 * Phase 1: Synthesizes browsing session with Chat model and saves checkpoint.
 * Zero embedding calls happen in this phase.
 */
export async function prepareSession(
  sdk: ShaleSDK,
  sessionId: string,
  startTime: number,
  endTime: number,
  visits: SessionVisitRecord[],
  settings: Partial<BrowserExtensionSettings>,
): Promise<PreparedSessionData> {
  const namespace = settings.namespace || sdk.namespace || "browser";
  const checkpointId = `browser_session:${sessionId}`;

  sdk.logger.info(
    `[browser] [Phase 1: Chat Model] Synthesizing session ${sessionId} (${visits.length} pages)...`,
  );
  const synthesis = await synthesizeSessionWithLLM(sdk, visits, settings);

  sdk.checkpoint.save(
    {
      type: "browser_session_analysis",
      sessionId,
      startTime,
      endTime,
      visits,
      synthesis,
      namespace,
    },
    { id: checkpointId, key: checkpointId },
  );

  return {
    sessionId,
    startTime,
    endTime,
    visits,
    synthesis,
    checkpointId,
    namespace,
  };
}

/**
 * Phase 2: Embeds session narrative with Embedding model and commits to graph.
 * Zero chat model calls happen in this phase.
 */
export async function finalizeSession(
  sdk: ShaleSDK,
  prepared: PreparedSessionData,
  settings: Partial<BrowserExtensionSettings>,
): Promise<IngestedSessionResult> {
  const { sessionId, startTime, endTime, visits, synthesis, checkpointId, namespace } = prepared;

  sdk.logger.info(
    `[browser] [Phase 2: Embedding Model] Embedding and ingesting session "${synthesis.sessionTitle}"...`,
  );

  const sessionText = [
    `Session: ${synthesis.sessionTitle}`,
    `Summary: ${synthesis.summary}`,
    `Topics: ${synthesis.topics.join(", ")}`,
    `Dominant Domains: ${synthesis.dominantDomains.join(", ")}`,
    `Pages Visited (${visits.length}):`,
    ...visits.map((v, i) => `${i + 1}. [${v.domain}] ${v.title} (${v.url})`),
  ].join("\n");

  const embedding = await sdk.embed(sessionText);

  const sessionUri = `browser-session://${sessionId}`;
  const sourceRes = sdk.ingest.sourceAndChunks({
    source: {
      id: `session:${sessionId}`,
      type: "web_session",
      uri: sessionUri,
      origin: "browser",
      title: synthesis.sessionTitle,
      created_at: startTime,
      updated_at: endTime,
    },
    chunks: [
      {
        chunk_index: 0,
        chunk_type: "synthetic",
        text_content: sessionText,
        embedding,
        entity_names: [synthesis.sessionTitle, ...synthesis.topics.slice(0, 3)],
      },
    ],
    namespace,
  });

  // Prepare graph entities
  const entities: Array<{ name: string; type: string; namespace: string }> = [
    { name: synthesis.sessionTitle, type: "WebSession", namespace },
  ];

  // Topic entities
  for (const topic of synthesis.topics) {
    if (topic) {
      entities.push({ name: topic, type: "Topic", namespace });
    }
  }

  // Dominant domain entities
  for (const domain of synthesis.dominantDomains) {
    if (domain) {
      entities.push({ name: domain, type: "Domain", namespace });
    }
  }

  // Page entities & session connection edges
  const edges: Array<{
    source: string;
    target: string;
    relation: string;
    weight: number;
    metadata?: any;
  }> = [];

  for (let i = 0; i < visits.length; i++) {
    const v = visits[i];
    if (v.title) {
      entities.push({ name: v.title, type: "WebPage", namespace });
      edges.push({
        source: synthesis.sessionTitle,
        target: v.title,
        relation: "CONTAINS_PAGE",
        weight: 1.0,
        metadata: {
          visitOrder: i + 1,
          visitedAt: v.visitedAt,
          domain: v.domain,
          url: v.url,
          transitionType: v.transitionType,
        },
      });
    }
  }

  // Topic coverage edges
  for (const topic of synthesis.topics) {
    edges.push({
      source: synthesis.sessionTitle,
      target: topic,
      relation: "COVERS_TOPIC",
      weight: 0.85,
    });
  }

  // Dominant domain edges
  for (const domain of synthesis.dominantDomains) {
    edges.push({
      source: synthesis.sessionTitle,
      target: domain,
      relation: "PRIMARY_DOMAIN",
      weight: 0.8,
    });
  }

  // Sequential navigation edges between pages
  const navEdges = buildSequentialEdges(visits);
  edges.push(...navEdges);

  // Ingest into knowledge graph
  const graphRes = sdk.graph.ingest({
    namespace,
    entities,
    edges,
  });

  // Resolve checkpoint
  sdk.checkpoint.delete(checkpointId);

  return {
    sourceId: sourceRes.sourceId,
    sessionId,
    title: synthesis.sessionTitle,
    summary: synthesis.summary,
    topics: synthesis.topics,
    pageCount: visits.length,
    edgesCount: graphRes.edgesInserted,
  };
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
  const prepared = await prepareSession(
    sdk,
    sessionId,
    startTime,
    endTime,
    visits,
    settings,
  );
  return await finalizeSession(sdk, prepared, settings);
}

/**
 * Records a page visit into the active session, finalizing and starting a new session if idle threshold exceeded.
 */
export async function recordSessionVisit(
  sdk: ShaleSDK,
  visit: SessionVisitRecord,
  explicitSessionId?: string,
  settings: Partial<BrowserExtensionSettings> = {},
): Promise<{
  activeSession: ActiveSessionState;
  finalizedSession?: IngestedSessionResult;
  sequentialEdge?: { source: string; target: string };
}> {
  const inactivityMinutes = settings.sessionInactivityMinutes ?? 30;
  const idleThresholdMs = inactivityMinutes * 60 * 1000;
  const now = visit.visitedAt || Date.now();

  let active = getActiveSession(sdk);
  let finalizedResult: IngestedSessionResult | undefined;

  // Check if existing session needs finalization due to idle timeout or explicit new session ID
  if (active) {
    const isIdle = now - active.lastActivityTime > idleThresholdMs;
    const isDifferentExplicitId =
      explicitSessionId && explicitSessionId !== active.sessionId;

    if (isIdle || isDifferentExplicitId) {
      if (active.visits.length > 0) {
        try {
          finalizedResult = await commitSessionToGraph(
            sdk,
            active.sessionId,
            active.startTime,
            active.lastActivityTime,
            active.visits,
            settings,
          );
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
    if (prev.title && visit.title && prev.title !== visit.title) {
      sequentialEdge = { source: prev.title, target: visit.title };
    }
  }

  // Append visit and update activity timestamp
  active.visits.push(visit);
  active.lastActivityTime = now;
  setActiveSession(sdk, active);

  return {
    activeSession: active,
    finalizedSession: finalizedResult,
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
export async function ingestSessionSnapshot(
  sdk: ShaleSDK,
  payload: SessionSnapshotPayload,
  settings: Partial<BrowserExtensionSettings> = {},
): Promise<IngestedSessionResult | null> {
  if (!payload.pages || payload.pages.length === 0) {
    return null;
  }

  const visits: SessionVisitRecord[] = payload.pages.map((p) => {
    let domain = "";
    try {
      domain = new URL(p.url).hostname;
    } catch {}
    return {
      url: p.url,
      title: p.title,
      domain,
      visitedAt: p.visitedAt,
      tabId: p.tabId,
      transitionType: p.transitionType,
    };
  });

  const endTime =
    payload.endTime ||
    visits[visits.length - 1]?.visitedAt ||
    Date.now();

  return commitSessionToGraph(
    sdk,
    payload.sessionId,
    payload.startTime,
    endTime,
    visits,
    settings,
  );
}
