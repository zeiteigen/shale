import { SourceGraph, type ShaleSDK } from "@shale/sdk";
import { commitPreparedClaims } from "../../sdk/graph/prepared";
import type { PreparedPageData } from "./types";

export function commitPageGraph(
  sdk: ShaleSDK,
  sourceId: string,
  prepared: PreparedPageData,
  topics: string[],
  imageOffset: number,
) {
  const { pageData: page, namespace, analysis, cleanUrl, domain } = prepared;
  const graph = new SourceGraph(
    sdk.database,
    sdk.graph,
    sourceId,
    namespace,
    page.visitedAt,
  );
  const cleanTitle = (page.title || domain || "Web Page")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const entity = graph.entity(cleanUrl, cleanTitle, "WebPage", cleanUrl);
  const observed = { evidence: graph.evidence(imageOffset - 1) };
  graph.claim(entity, "SOURCE_URI", { value: cleanUrl }, observed);
  if (page.captureOrigin)
    graph.claim(
      entity,
      "CAPTURE_ORIGIN",
      { value: page.captureOrigin },
      observed,
    );
  graph.claim(entity, "TITLE", { value: cleanTitle }, observed);
  graph.link(
    entity,
    "BELONGS_TO_DOMAIN",
    graph.entity(domain, domain, "Domain", domain),
    observed,
  );
  const interpretation = {
    status: "proposed" as const,
    method: analysis.method ?? "llm",
    model: analysis.model,
    evidence: [
      ...graph.evidence(1, undefined, analysis.method ?? "llm"),
      ...graph.evidence(0, undefined, "generated", "mentions"),
    ],
  };
  graph.claim(entity, "SUMMARY", { value: analysis.summary }, interpretation);
  graph.claim(entity, "CATEGORY", { value: analysis.category }, interpretation);
  if (prepared.contextualSummary)
    graph.claim(
      entity,
      "RETRIEVAL_CONTEXT",
      { value: prepared.contextualSummary },
      {
        ...interpretation,
        method: prepared.parser?.contextMethod ?? "llm",
        model: prepared.parser?.contextModel,
      },
    );
  for (const topic of topics)
    graph.link(
      entity,
      "HAS_TOPIC",
      graph.entity(topic.toLocaleLowerCase(), topic, "Topic", topic),
      interpretation,
    );
  if (page.author)
    graph.claim(
      entity,
      "AUTHOR",
      { value: page.author },
      { evidence: graph.quote(page.author) },
    );
  for (const link of page.links ?? []) {
    let url: string;
    try {
      url = new URL(link.url, cleanUrl).href;
      if (!/^https?:/.test(url)) continue;
    } catch {
      continue;
    }
    const linkText = (link.text || "").trim();
    const cleanLinkTitle = linkText
      ? linkText.replace(/\s+/g, " ").slice(0, 200)
      : url;
    const target = graph.entity(url, cleanLinkTitle, "WebPage", url);
    graph.link(entity, "REFERENCES", target, {
      method: "dom",
      evidence: graph.quote(link.url),
      qualifiers: { anchor: link.text ?? "", rel: link.rel ?? "" },
    });
  }
  for (const image of page.images ?? []) {
    const target = graph.entity(
      image.url,
      (image.alt || image.url).slice(0, 200),
      "Image",
    );
    graph.link(entity, "FEATURES_IMAGE", target, {
      method: "dom",
      evidence: graph.quote(image.url),
      qualifiers: {
        alt: image.alt ?? "",
        ...(image.width === undefined ? {} : { width: image.width }),
        ...(image.height === undefined ? {} : { height: image.height }),
      },
    });
  }
  for (const image of prepared.parser?.imageKnowledge ?? []) {
    const target = graph.entity(image.uri, image.title, "Image");
    graph.link(entity, "FEATURES_IMAGE", target, { method: "html" });
    commitPreparedClaims(graph, target, image.claims, imageOffset);
  }
  if (prepared.jobId) return graph;
  const sessionId =
    prepared.sessionUpdate?.activeSession.sessionId ?? page.sessionId;
  const visit = graph.event(
    `visit:${page.visitedAt}:${page.tabId ?? ""}:${sessionId ?? ""}`,
    {
      name: `${page.recordInSession === false ? "Observed" : "Visited"} ${cleanTitle}`,
      kind: page.recordInSession === false ? "page_observation" : "page_visit",
      occurredFrom: page.visitedAt,
      participants: [{ entity, role: "page" }],
      evidence: observed.evidence,
    },
  );
  for (const key of [
    "tabId",
    "windowId",
    "openerTabId",
    "transitionType",
  ] as const)
    if (page[key] !== undefined)
      graph.claim(visit, key.toUpperCase(), { value: page[key]! }, observed);
  if (sessionId)
    graph.claim(visit, "SESSION_ID", { value: sessionId }, observed);
  const sequential = prepared.sessionUpdate?.sequentialEdge;
  if (sequential)
    graph.link(
      graph.entity(
        sequential.source,
        sequential.source,
        "WebPage",
        sequential.source,
      ),
      "NAVIGATED_TO",
      entity,
      {
        context: `browser-session://${sessionId}`,
        qualifiers: {
          timestamp: page.visitedAt,
          transitionType: page.transitionType ?? "",
          tabId: page.tabId ?? null,
        },
        observedAt: page.visitedAt,
        evidence: observed.evidence,
      },
    );
  return graph;
}
