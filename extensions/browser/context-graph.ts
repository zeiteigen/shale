import { SourceGraph, type ShaleSDK } from "@shale/sdk";
import type { PreparedSessionData } from "./types";
/** Thread labels and goals carry evidence and inference status independently of visits. */
export function commitContextGraph(
  sdk: ShaleSDK,
  sourceId: string,
  prepared: PreparedSessionData,
) {
  const graph = new SourceGraph(
    sdk.database,
    sdk.graph,
    sourceId,
    prepared.namespace,
    prepared.endTime,
  );
  const session = graph.entity(
    `browser-session://${prepared.sessionId}`,
    prepared.synthesis.sessionTitle,
    "WebSession",
  );
  for (const thread of prepared.threads ?? []) {
    const entity = graph.entity(
      `browser-thread://${thread.id}`,
      thread.label,
      "ResearchThread",
    );
    const interpretation = {
      status:
        thread.method === "user"
          ? ("accepted" as const)
          : ("proposed" as const),
      method: thread.method,
      model: thread.model,
      confidence: thread.confidence,
      evidence: [
        ...graph.evidence(1),
        ...graph.evidence(0, undefined, "generated", "supports"),
      ],
    };
    graph.link(session, "PART_OF_THREAD", entity, interpretation);
    graph.claim(
      entity,
      "THREAD_LABEL",
      { value: thread.label },
      interpretation,
    );
    if (thread.goal)
      graph.claim(entity, "HAS_GOAL", { value: thread.goal }, interpretation);
    for (const topic of thread.topics)
      graph.link(
        entity,
        "HAS_TOPIC",
        graph.entity(topic.toLowerCase(), topic, "Topic", topic),
        { ...interpretation, status: "proposed" },
      );
    for (const visit of prepared.visits.filter((v) =>
      thread.eventIds.includes(v.eventId ?? ""),
    )) {
      graph.link(
        graph.entity(visit.url, visit.title, "WebPage", visit.url),
        "PART_OF_THREAD",
        entity,
        { ...interpretation, qualifiers: { eventId: visit.eventId ?? "" } },
      );
      sdk.database
        .query(
          `INSERT INTO browser_context_members VALUES(?,?,?,?,?) ON CONFLICT(extension_id,collector_id,event_id)
        DO UPDATE SET thread_id=excluded.thread_id,session_id=excluded.session_id`,
        )
        .run(
          sdk.extensionId,
          visit.collectorId ?? "legacy",
          visit.eventId!,
          thread.id,
          prepared.sessionId,
        );
    }
    sdk.database
      .query(
        `INSERT INTO browser_threads VALUES(?,?,?,?,?,?) ON CONFLICT(extension_id,thread_id)
      DO UPDATE SET label=excluded.label,goal=excluded.goal,topics=excluded.topics,updated_at=excluded.updated_at`,
      )
      .run(
        sdk.extensionId,
        thread.id,
        thread.label,
        thread.goal ?? null,
        JSON.stringify(thread.topics),
        Date.now(),
      );
  }
}
