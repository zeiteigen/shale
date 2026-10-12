import { SourceGraph, graphIdentity, type ShaleSDK } from "@shale/sdk";
import { commitPreparedClaims } from "../../sdk/graph/prepared";
import { normalizeUrl } from "./filter";
import type { PreparedPageData } from "./types";
import { isDecorativeImage as decorativeImage, type ImageCandidate } from "../../lib/decorative-images";

/** Preserve the browser graph's unsupported data-URL behavior. */
export function isDecorativeImage(image: ImageCandidate): boolean {
  return /^data:/i.test(image.url) || decorativeImage(image);
}

const GENERIC_ANCHORS = new Set([
  "read more",
  "more",
  "here",
  "click here",
  "next",
  "previous",
  "prev",
  "back",
  "learn more",
  "see more",
  "see all",
  "view all",
  "show more",
  "continue",
  "continue reading",
  "details",
  "link",
  "source",
  "top",
  "back to top",
  "skip to content",
  "skip to main content",
]);

/** Navigation chrome anchors ("Read more", "Next") carry no information about the target. */
export function isGenericAnchor(text: string | undefined): boolean {
  const key = (text ?? "")
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim()
    .toLocaleLowerCase();
  return !key || GENERIC_ANCHORS.has(key);
}

/** A page is known once something other than an inbound link asserted it: a visit, history, session or capture. */
function isKnownPage(sdk: ShaleSDK, namespace: string, url: string): boolean {
  return Boolean(
    sdk.database
      .query(
        `SELECT 1 FROM entities e WHERE e.stable_id=? AND (
          EXISTS(SELECT 1 FROM graph_claims c WHERE c.subject_id=e.id AND c.status IN ('accepted','proposed','disputed'))
          OR EXISTS(SELECT 1 FROM graph_participants p WHERE p.entity_id=e.id))`,
      )
      .get(graphIdentity(namespace, "WebPage", url)),
  );
}

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
  const observed = { evidence: graph.evidence(0) };
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
  const seenLinks = new Set<string>();
  for (const link of page.links ?? []) {
    let norm: ReturnType<typeof normalizeUrl>;
    try {
      norm = normalizeUrl(new URL(link.url, cleanUrl).href);
    } catch {
      continue;
    }
    const url = norm.cleanUrl;
    if (!norm.isValid || url === cleanUrl || seenLinks.has(url)) continue;
    seenLinks.add(url);
    const options = {
      method: "dom",
      evidence: graph.quote(link.url),
      qualifiers: { anchor: link.text ?? "", rel: link.rel ?? "" },
    };
    // Only pages Shale already knows become nodes; a node per outbound anchor floods the graph.
    // The URL is the label so anchor text never renames a page that has its own title.
    if (isKnownPage(sdk, namespace, url)) {
      graph.link(entity, "REFERENCES", graph.entity(url, url, "WebPage", url), options);
      continue;
    }
    if (isGenericAnchor(link.text)) continue;
    graph.claim(entity, "LINKS_TO", { value: url }, options);
  }
  for (const image of page.images ?? []) {
    if (isDecorativeImage(image)) continue;
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
  for (const image of prepared.imageKnowledge ?? []) {
    if (isDecorativeImage({ url: image.uri })) continue;
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
