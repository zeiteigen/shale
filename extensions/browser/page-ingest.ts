import type { ShaleSDK } from "@shale/sdk";
import type { WebPageParseResponse } from "../../lib/messages/web-contracts";
import type { PageVisitPayload, PreparedPageData, WebPageData, IngestedPageResult } from "./types";
import type { BrowserExtensionSettings } from "./settings.types";
import { evaluateUrl } from "./filter";
import { analyzePageWithLLM } from "./llm-enricher";
import { browserSourceId, sanitizeTopics } from "./identity";
import { recordSessionVisit } from "./session-manager";
import { finalizeSession } from "./session-ingest";
import { chunkText } from "./chunk-text";
import { commitPageGraph } from "./page-graph";

/**
 * Phase 1: Discovers and prepares a web page using Chat model analysis and checkpoints.
 * Zero embedding calls happen in this phase, keeping the Chat model loaded in GPU memory.
 */
export async function preparePageVisit(
  sdk: ShaleSDK,
  payload: PageVisitPayload,
  settings: Partial<BrowserExtensionSettings>,
): Promise<PreparedPageData | null> {
  const filter = evaluateUrl(payload.url, settings);
  if (!filter.allowed) {
    sdk.logger.debug(`Excluded page "${payload.url}": ${filter.reason}`);
    return null;
  }

  const title = (payload.title || filter.domain || "Untitled Page").trim();
  sdk.logger.info(
    `[browser] [Phase 1: Chat Model] Preparing "${title}" (${filter.domain})`,
  );
  let rawContent = (payload.textContent || payload.excerpt || title).trim();
  let parser: WebPageParseResponse | undefined;
  let parsedChunks: string[] | undefined;
  let contextualSummary: string | undefined;
  let imageChunks:
    | Array<{
        text_content: string;
        chunk_type: "verbatim" | "synthetic";
      }>
    | undefined;
  // The page parser owns HTML/readability extraction, contextualization, and
  // image delegation. It is optional so browser ingestion remains usable when
  // this extension is intentionally not installed.
  try {
    const parsed = await sdk.messages.request(
      "web:parse",
      {
        url: filter.cleanUrl,
        title,
        textContent: rawContent,
        html: payload.html,
        imageUrls: payload.images?.map((image) => image.url),
        includeImages: true,
        // Parsing may include local LLM and vision calls; allow the same cold-load
        // window used by Shale's local-model clients instead of timing out at 1.5s.
      },
      { target: "web-page-parser", timeoutMs: 300000 },
    );
    parser = parsed;
    rawContent = parsed.text || rawContent;
    parsedChunks = parsed.chunks;
    contextualSummary = parsed.contextualSummary;
    imageChunks = parsed.imageChunks.map(chunk=>({...chunk,chunk_type:"synthetic"}));
  } catch (error) {
    sdk.logger.debug(
      `Web-page parser unavailable for ${filter.cleanUrl}; using browser content: ${String(error)}`,
    );
  }
  const visitedAt = payload.visitedAt || Date.now();
  const namespace = settings.namespace || sdk.namespace || "browser";

  const pageData: WebPageData = {
    url: payload.url,
    cleanUrl: filter.cleanUrl,
    domain: filter.domain,
    title,
    textContent: rawContent,
    excerpt: payload.excerpt || rawContent.slice(0, 300),
    favIconUrl: payload.favIconUrl,
    author: payload.author,
    links: payload.links,
    images: payload.images,
    visitedAt,
    tabId: payload.tabId,
    windowId: payload.windowId,
    openerTabId: payload.openerTabId,
    transitionType: payload.transitionType,
    recordInSession: payload.recordInSession,
    sessionId: payload.sessionId,
  };

  // Phase 1 Chat Model Call: generate summary, topics, and category
  const checkpointId = `browser_page:${filter.cleanUrl}`;
  const analysis = await analyzePageWithLLM(sdk, pageData, settings);
  const sessionUpdate =
    pageData.recordInSession === false
      ? null
      : await recordSessionVisit(
          sdk,
          {
            url: filter.cleanUrl,
            title,
            domain: filter.domain,
            visitedAt,
            tabId: pageData.tabId,
            windowId: pageData.windowId,
            openerTabId: pageData.openerTabId,
            transitionType: pageData.transitionType,
            pageSourceId: browserSourceId("web", filter.cleanUrl),
          },
          pageData.sessionId,
          settings,
          true,
        );

  // Save checkpoint to SQLite (guarantees zero lost tokens if interrupted)
  sdk.checkpoint.save(
    {
      type: "browser_page_analysis",
      pageData,
      analysis,
      namespace,
      // Keep parser output in the checkpoint so recovery can commit the same
      // rich page (HTML-derived chunks, links, and image descriptions) without
      // calling the parser or LLM again.
      parser,
      parsedChunks,
      contextualSummary,
      imageChunks,
      sessionUpdate,
    },
    { id: checkpointId, key: checkpointId },
  );

  return {
    pageData,
    analysis,
    cleanUrl: filter.cleanUrl,
    domain: filter.domain,
    checkpointId,
    namespace,
    parser,
    parsedChunks,
    contextualSummary,
    imageChunks,
    sessionUpdate,
  };
}

/**
 * Phase 2: Embeds prepared page chunks with the Embedding model and commits
 * sources, chunks, and graph edges to SQLite. Zero Chat model calls happen in this phase.
 */
export async function finalizePageVisit(
  sdk: ShaleSDK,
  prepared: PreparedPageData,
  settings: Partial<BrowserExtensionSettings>,
): Promise<IngestedPageResult> {
  const { pageData, analysis, cleanUrl, domain, checkpointId, namespace } =
    prepared;
  if (prepared.sessionUpdate?.preparedSession) {
    await finalizeSession(
      sdk,
      prepared.sessionUpdate.preparedSession,
      settings,
    );
  }
  const title = pageData.title;
  const rawContent = pageData.textContent;
  const visitedAt = pageData.visitedAt;

  sdk.logger.info(
    `[browser] [Phase 2: Embedding Model] Embedding and ingesting "${title}" (${domain})`,
  );

  // Phase 2 Chunking & Embeddings
  const chunkSize = settings.chunkSize ?? 1000;
  const rawChunks = chunkText(
    prepared.parsedChunks?.length
      ? prepared.parsedChunks.join("\n\n")
      : rawContent,
    chunkSize,
  ).filter(Boolean);
  const topics =
    settings.extractTopics === false
      ? []
      : sanitizeTopics(analysis.topics, { title, domain });

  const referenceLines = [
    ...(pageData.author ? [`Author: ${pageData.author}`] : []),
    ...(pageData.links ?? []).map(
      (link) => `Link: ${link.text?.trim() || link.url}\nURL: ${link.url}`,
    ),
    ...(pageData.images ?? []).map(
      (image) =>
        `Image: ${image.alt?.trim() || "Untitled image"}\nURL: ${image.url}`,
    ),
  ];
  const referenceChunks = referenceLines.length
    ? chunkText(referenceLines.join("\n\n"), chunkSize)
    : [];

  const chunkRecords = [
    {
      text_content: `Page: ${title}\nURL: ${cleanUrl}\nDomain: ${domain}\nSummary: ${analysis.summary}\nContext: ${prepared.contextualSummary ?? ""}${topics.length ? `\nTopics: ${topics.join(", ")}` : ""}`,
      chunk_type: "synthetic" as const,
    },
    ...rawChunks.map((text_content) => ({
      text_content,
      chunk_type: "verbatim" as const,
    })),
    ...referenceChunks.map((text_content) => ({
      text_content,
      chunk_type: "verbatim" as const,
    })),
    {text_content:JSON.stringify({url:cleanUrl,title,domain,visitedAt,author:pageData.author,
      tabId:pageData.tabId,windowId:pageData.windowId,openerTabId:pageData.openerTabId,
      transitionType:pageData.transitionType,sessionId:pageData.sessionId,
      links:pageData.links,images:pageData.images},null,2),chunk_type:"verbatim" as const},
    ...(prepared.imageChunks ?? []).map(chunk=>({...chunk,chunk_type:"synthetic" as const})),
  ];
  const chunksToEmbed = chunkRecords.map((chunk) => chunk.text_content);

  const embeddings = await sdk.embed(chunksToEmbed);

  const sourceId = browserSourceId("web", cleanUrl);
  const {sourceRes,graphRes} = sdk.database.transaction(() => {
    const sourceRes = sdk.ingest.sourceAndChunks({
      source: {id:sourceId,type:"web_page",uri:cleanUrl,origin:"browser",title,
        created_at:visitedAt,updated_at:visitedAt},
      chunks:chunkRecords.map((chunk,i)=>({...chunk,chunk_index:i,embedding:embeddings[i]})),namespace,
    });
    const imageOffset = 2 + rawChunks.length + referenceChunks.length;
    const graph = commitPageGraph(sdk,sourceRes.sourceId,prepared,topics,imageOffset);
    sdk.checkpoint.delete(checkpointId);
    return {sourceRes,graphRes:{entitiesInserted:graph.entities.size,edgesInserted:graph.edgesCount}};
  })();
  const sessionUpdate = prepared.sessionUpdate;

  return {
    sourceId: sourceRes.sourceId,
    chunkIds: sourceRes.chunkIds,
    entitiesCount: graphRes.entitiesInserted,
    edgesCount: graphRes.edgesInserted,
    summary: analysis.summary,
    category: analysis.category,
    topics,
    sessionId: sessionUpdate?.activeSession.sessionId,
  };
}

