import { fingerprint } from "./inbox-store";
import { isSourceExcluded } from "../../lib/knowledge/exclusions";
import { ensureBrowserSchema } from "./storage-schema";
import { commitContextGraph } from "./context-graph";
import {
  commitActivityGraph,
  visitSource,
} from "./activity-graph";
import type { ShaleSDK } from "@shale/sdk";
import type {
  PreparedSessionData,
  SessionVisitRecord,
  IngestedSessionResult,
} from "./types";
import type { BrowserExtensionSettings } from "./settings.types";
import { synthesizeSessionWithLLM } from "./llm-enricher";
import { sanitizeTopics, sessionEntityName } from "./identity";
import { commitSessionGraph } from "./session-graph";
import { sessionChunks } from "./session-chunks";

/**
 * Synthesize a browsing session with the chat model and save a checkpoint.
 */
export async function prepareSession(
  sdk: ShaleSDK,
  sessionId: string,
  startTime: number,
  endTime: number,
  visits: SessionVisitRecord[],
  settings: Partial<BrowserExtensionSettings>,
  observed?: Pick<
    PreparedSessionData,
    "collectorId" | "activityHash" | "boundaryReason"
  >,
): Promise<PreparedSessionData> {
  ensureBrowserSchema(sdk.database);
  const namespace = settings.namespace || sdk.namespace || "browser";
  const checkpointId = `browser_session:${sessionId}`;

  sdk.logger.info(
    `[browser] Synthesizing session ${sessionId} (${visits.length} pages)...`,
  );
  const synthesis = await synthesizeSessionWithLLM(sdk, visits, settings);

  sdk.checkpoint.save(
    {
      type: "browser_session_analysis",
      ...observed,
      settings,
      sessionId,
      startTime,
      endTime,
      visits,
      synthesis,
      namespace,
    },
    {
      id: checkpointId,
      key: checkpointId,
      status: observed ? "preparing" : "queued",
    },
  );

  return {
    ...observed,
    settings,
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
 * Commit a prepared session narrative and its graph evidence.
 */
export async function finalizeSession(
  sdk: ShaleSDK,
  prepared: PreparedSessionData,
  settings: Partial<BrowserExtensionSettings>,
  assertOwned: () => void = () => {},
): Promise<IngestedSessionResult> {
  const {
    sessionId,
    startTime,
    endTime,
    visits,
    synthesis,
    checkpointId,
    namespace,
  } = prepared;
  const sessionEntity = sessionEntityName(sessionId);
  const sessionSourceId = `session:${sessionId}`;
  if (isSourceExcluded(sdk.database, sessionSourceId, sessionEntity)) {
    sdk.checkpoint.delete(checkpointId);
    return { sourceId: sessionSourceId, sessionId, title: synthesis.sessionTitle,
      summary: synthesis.summary, topics: [], pageCount: 0, edgesCount: 0 };
  }
  const actualDomains = [
    ...new Set(visits.map((visit) => visit.domain).filter(Boolean)),
  ];
  const actualDomainKeys = new Set(
    actualDomains.map((domain) => domain.toLocaleLowerCase()),
  );
  const dominantDomains = synthesis.dominantDomains.filter((domain) =>
    actualDomainKeys.has(domain.toLocaleLowerCase()),
  );
  const topics = sanitizeTopics(synthesis.topics, {
    title: synthesis.sessionTitle,
  });

  sdk.logger.info(
    `[browser] Ingesting session "${synthesis.sessionTitle}"...`,
  );

  const sessionText = [
    `Session: ${synthesis.sessionTitle}`,
    `Summary: ${synthesis.summary}`,
    ...(topics.length ? [`Topics: ${topics.join(", ")}`] : []),
    ...(dominantDomains.length
      ? [`Dominant Domains: ${dominantDomains.join(", ")}`]
      : []),
  ].join("\n");

  const chunks = sessionChunks(sessionText, "", settings.chunkSize ?? 1000);
  const unseen = prepared.collectorId
    ? visits.filter(
        (v) =>
        !sdk.database
            .query("SELECT 1 FROM sources WHERE id=?")
            .get(visitSource(v).id) &&
          !isSourceExcluded(sdk.database, visitSource(v).id, visitSource(v).uri),
      )
    : [];
  assertOwned();
  const { sourceRes, edgesCount } = sdk.database.transaction(() => {
    if (prepared.collectorId) {
      const current = sdk.database
        .query<{ prepared: string | null }, [string, string]>(
          "SELECT prepared FROM browser_sessions WHERE extension_id=? AND session_id=?",
        )
        .get(sdk.extensionId, sessionId);
      const currentPrepared = current?.prepared
        ? JSON.parse(current.prepared)
        : null;
      const { settings: _settings, ...preparedForCommit } = prepared;
      if (
        !currentPrepared ||
        fingerprint({ ...currentPrepared, type: undefined }) !==
          fingerprint({ ...preparedForCommit, type: undefined })
      )
        throw new Error(
          "Session preparation was superseded; recompute context",
        );
    }

    const sourceRes = sdk.ingest.sourceAndChunks({
      namespace,
      source: {
        id: `session:${sessionId}`,
        type: "web_session",
        uri: sessionEntity,
        origin: "browser",
        title: synthesis.sessionTitle,
        created_at: startTime,
        updated_at: endTime,
      },
      chunks,
    });
    if (sourceRes.skipped) {
      sdk.checkpoint.delete(checkpointId);
      return { sourceRes, edgesCount: 0 };
    }
    const graph = commitSessionGraph(
      sdk,
      sourceRes.sourceId,
      prepared,
      topics,
      dominantDomains,
    );
    if (prepared.collectorId) {
      for (const [index, visit] of unseen.entries())
        commitActivityGraph(sdk, visit, prepared);
      // Late observations can change a session's first event and therefore its identity.
      // Replace overlapping derived sessions; immutable event sources remain untouched.
      const eventIds = visits.map((v) => v.eventId).filter(Boolean);
      if (eventIds.length) {
        const obsolete = sdk.database
          .query<{ session_id: string }, any[]>(
            `SELECT DISTINCT session_id FROM browser_context_members
        WHERE extension_id=? AND collector_id=? AND session_id!=? AND event_id IN (${eventIds.map(() => "?").join(",")})`,
          )
          .all(sdk.extensionId, prepared.collectorId, sessionId, ...eventIds);
        for (const row of obsolete) {
          sdk.database
            .query("DELETE FROM sources WHERE id=?")
            .run(`session:${row.session_id}`);
          sdk.database
            .query(
              "DELETE FROM browser_context_members WHERE extension_id=? AND session_id=?",
            )
            .run(sdk.extensionId, row.session_id);
          sdk.database
            .query(
              "DELETE FROM browser_sessions WHERE extension_id=? AND session_id=?",
            )
            .run(sdk.extensionId, row.session_id);
          sdk.checkpoint.delete(`browser_session:${row.session_id}`);
        }
      }
      commitContextGraph(sdk, sourceRes.sourceId, prepared);
      sdk.database
        .query(
          "UPDATE browser_sessions SET indexed_hash=?,prepared=NULL,settings=NULL,prepared_at=NULL,error=NULL,attempts=0,next_attempt_at=0 WHERE extension_id=? AND session_id=? AND activity_hash=?",
        )
        .run(
          prepared.activityHash!,
          sdk.extensionId,
          sessionId,
          prepared.activityHash!,
        );
    }
    sdk.checkpoint.delete(checkpointId);
    return { sourceRes, edgesCount: graph.edgesCount };
  })();

  return {
    sourceId: sourceRes.sourceId,
    sessionId,
    title: synthesis.sessionTitle,
    summary: synthesis.summary,
    topics,
    pageCount: visits.length,
    edgesCount,
  };
}
