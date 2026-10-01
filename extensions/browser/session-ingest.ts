import type { ShaleSDK } from "@shale/sdk";
import type { PreparedSessionData, SessionVisitRecord, IngestedSessionResult } from "./types";
import type { BrowserExtensionSettings } from "./settings.types";
import { synthesizeSessionWithLLM } from "./llm-enricher";
import { sanitizeTopics, sessionEntityName } from "./identity";
import { commitSessionGraph, sessionObservationText } from "./session-graph";

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
    `[browser] [Phase 2: Embedding Model] Embedding and ingesting session "${synthesis.sessionTitle}"...`,
  );

  const sessionText = [
    `Session: ${synthesis.sessionTitle}`,
    `Summary: ${synthesis.summary}`,
    `Topics: ${topics.join(", ")}`,
    `Dominant Domains: ${dominantDomains.join(", ")}`,
    `Pages Visited (${visits.length}):`,
    ...visits.map((v, i) => `${i + 1}. [${v.domain}] ${v.title} (${v.url})`),
  ].join("\n");

  const observationText = sessionObservationText(prepared);
  const embeddings = await sdk.embed([sessionText,observationText]);
  const {sourceRes,edgesCount} = sdk.database.transaction(() => {
    const sourceRes = sdk.ingest.sourceAndChunks({namespace,
      source:{id:`session:${sessionId}`,type:"web_session",uri:sessionEntity,origin:"browser",
        title:synthesis.sessionTitle,created_at:startTime,updated_at:endTime},
      chunks:[{chunk_index:0,chunk_type:"synthetic",text_content:sessionText,embedding:embeddings[0]},
        {chunk_index:1,chunk_type:"verbatim",text_content:observationText,embedding:embeddings[1]}],
    });
    const graph = commitSessionGraph(sdk,sourceRes.sourceId,prepared,topics,dominantDomains);
    sdk.checkpoint.delete(checkpointId);
    return {sourceRes,edgesCount:graph.edgesCount};
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

