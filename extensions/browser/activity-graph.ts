import type { ActivityEventPayload } from "../../lib/browser-contract";
import type { BrowserExtensionSettings } from "./settings.types";
import { normalizeUrl } from "./filter";
import { SourceGraph, graphIdentity, type ShaleSDK } from "@shale/sdk";
import type { PreparedSessionData, SessionVisitRecord } from "./types";
import { fingerprint } from "./inbox-store";
import { isSourceExcluded } from "../../lib/knowledge/exclusions";

export function visitSource(visit: SessionVisitRecord) {
  const collector = visit.collectorId ?? "legacy",
    id = visit.eventId ?? fingerprint(visit);
  return {
    id: `activity:${fingerprint([collector, id])}`,
    uri: `browser-event://${encodeURIComponent(collector)}/${encodeURIComponent(id)}`,
  };
}
/** Immutable visit evidence is independent of mutable page/session summaries. */
export function commitActivityGraph(
  sdk: ShaleSDK,
  visit: SessionVisitRecord,
  prepared: PreparedSessionData,
) {
  const identity = visitSource(visit);
  if (isSourceExcluded(sdk.database, identity.id, identity.uri)) return null;
  if (sdk.database.query("SELECT 1 FROM sources WHERE id=?").get(identity.id))
    return;
  const observation = visitObservation(sdk, visit);
  sdk.ingest.sourceAndChunks({
    source: {
      ...identity,
      type: "browser_activity",
      origin: "browser",
      title: visit.title,
      created_at: visit.visitedAt,
      updated_at: visit.visitedAt,
    },
    namespace: prepared.namespace,
    chunks: [
      {
        chunk_index: 0,
        chunk_type: "verbatim",
        text_content: observation,
      },
    ],
  });
  const graph = new SourceGraph(
    sdk.database,
    sdk.graph,
    identity.id,
    prepared.namespace,
    visit.visitedAt,
  );
  const page = graph.entity(visit.url, visit.title, "WebPage", visit.url);
  const event = graph.event("visit", {
    name: `Visit: ${visit.title}`,
    kind: "page_visit",
    occurredFrom: visit.visitedAt,
    participants: [{ entity: page, role: "page" }],
  });
  for (const key of [
    "tabId",
    "windowId",
    "openerTabId",
    "transitionType",
  ] as const)
    if (visit[key] !== undefined)
      graph.claim(event, key.toUpperCase(), { value: visit[key]! });
}

export function visitObservation(sdk: ShaleSDK, visit: SessionVisitRecord) {
  const original = sdk.database
    .query<{ payload: string }, [string, string, string]>(
      "SELECT payload FROM browser_activity WHERE extension_id=? AND collector_id=? AND event_id=?",
    )
    .get(sdk.extensionId, visit.collectorId ?? "legacy", visit.eventId ?? "");
  const observed = original?.payload ? JSON.parse(original.payload) : visit;
  const title = String(observed.title ?? visit.title ?? visit.url).slice(0, 160);
  const url = String(observed.url ?? visit.url).slice(0, 500);
  const at = Number(observed.visitedAt ?? visit.visitedAt);
  return `Visit: ${title}\nURL: ${url}\nVisited: ${new Date(at).toISOString()}`;
}

/** Activity kinds recorded as measurements of a visit rather than as events of their own. */
const ACTIVITY_MEASURES = {
  attention: "ATTENTION_MS",
  activation: "ACTIVATED_AT",
  close: "CLOSED_AT",
} as const;

/** The page_visit event of the navigation this activity belongs to, when it was already committed. */
function parentVisit(
  sdk: ShaleSDK,
  namespace: string,
  event: ActivityEventPayload,
): number | undefined {
  if (!event.navigationEventId) return undefined;
  const parent = visitSource({
    collectorId: event.collectorId,
    eventId: event.navigationEventId,
  } as SessionVisitRecord);
  const source = sdk.database
    .query<{ hash: string }, [string]>("SELECT hash FROM sources WHERE id=?")
    .get(parent.id);
  if (!source) return undefined;
  return sdk.database
    .query<{ id: number }, [string]>("SELECT id FROM entities WHERE stable_id=?")
    .get(graphIdentity(namespace, "Event", `${parent.id}:${source.hash}:visit`))
    ?.id;
}

/** Activity receipts become indexed independently of idle-session synthesis. */
export async function finalizeActivity(
  sdk: ShaleSDK,
  event: ActivityEventPayload,
  settings: Partial<BrowserExtensionSettings>,
  assertOwned: () => void,
  afterCommit: () => void,
) {
  const visit = { ...event, domain: normalizeUrl(event.url).domain };
  const identity = visitSource(visit);
  if (sdk.database.query("SELECT 1 FROM sources WHERE id=?").get(identity.id)) {
    assertOwned();
    sdk.database.transaction(afterCommit)();
    return;
  }
  const text = visitObservation(sdk, visit);
  assertOwned();
  sdk.database.transaction(() => {
    const namespace = settings.namespace || sdk.namespace || "browser";
    sdk.ingest.sourceAndChunks({
      namespace,
      source: {
        ...identity,
        type: "browser_activity",
        origin: "browser",
        title: event.title || event.url,
        created_at: event.visitedAt,
        updated_at: event.visitedAt,
      },
      chunks: [
        {
          chunk_index: 0,
          chunk_type: "verbatim",
          text_content: text,
        },
      ],
    });
    const graph = new SourceGraph(
      sdk.database,
      sdk.graph,
      identity.id,
      namespace,
      event.visitedAt,
    );
    const page = graph.entity(
      event.url,
      event.title || event.url,
      "WebPage",
      event.url,
    );
    if (event.kind in ACTIVITY_MEASURES) {
      // Focus/attention/close refine a visit; as separate events they were 30% of all nodes.
      const subject = parentVisit(sdk, namespace, event) ?? page;
      const predicate =
        ACTIVITY_MEASURES[event.kind as keyof typeof ACTIVITY_MEASURES];
      const qualifiers = {
        observedAt: event.visitedAt,
        ...(event.tabId === undefined ? {} : { tabId: event.tabId }),
        ...(event.documentId === undefined ? {} : { documentId: event.documentId }),
        ...(event.attended === undefined ? {} : { attended: event.attended }),
      };
      graph.claim(
        subject,
        predicate,
        {
          value:
            event.kind === "attention" ? (event.durationMs ?? 0) : event.visitedAt,
        },
        { qualifiers },
      );
      afterCommit();
      return;
    }
    const occurrence = graph.event("visit", {
      name: `${event.kind}: ${event.title || event.url}`,
      kind:
        event.kind === "navigation" ? "page_visit" : `browser_${event.kind}`,
      occurredFrom: event.visitedAt,
      participants: [{ entity: page, role: "page" }],
    });
    for (const key of [
      "tabId",
      "windowId",
      "openerTabId",
      "documentId",
      "transitionType",
      "durationMs",
      "attended",
    ] as const)
      if (event[key] !== undefined)
        graph.claim(occurrence, key.toUpperCase(), { value: event[key]! });
    afterCommit();
  })();
}
