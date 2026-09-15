import { randomUUIDv7 } from "bun";
import type { ShaleSDK } from "@shale/sdk";
import type {
  BookmarksBatchPayload,
  BrowserIngestPayload,
  HistoryBatchPayload,
  IngestedPageResult,
  PageVisitPayload,
  PreparedPageData,
  SessionSnapshotPayload,
  SessionVisitRecord,
  TabsBatchPayload,
  WebPageData,
} from "./types";
import type { BrowserExtensionSettings } from "./settings.types";
import { evaluateUrl } from "./filter";
import { analyzePageWithLLM } from "./llm-enricher";
import {
  ingestSessionSnapshot,
  recordSessionVisit,
} from "./session-manager";

/**
 * Splits text into chunks of target character size on sentence or paragraph boundaries.
 */
export function chunkText(text: string, targetChunkSize: number = 1000): string[] {
  const clean = text.trim();
  if (!clean) return [""];
  if (clean.length <= targetChunkSize) {
    return [clean];
  }

  const chunks: string[] = [];
  const paragraphs = clean.split(/\n\s*\n/);
  let currentChunk = "";

  for (const para of paragraphs) {
    if ((currentChunk + "\n\n" + para).length <= targetChunkSize) {
      currentChunk = currentChunk ? currentChunk + "\n\n" + para : para;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }
      if (para.length > targetChunkSize) {
        // Break paragraph by sentences
        const sentences = para.match(/[^.!?]+[.!?]+(\s|$)/g) || [para];
        for (const sent of sentences) {
          if ((currentChunk + " " + sent).length <= targetChunkSize) {
            currentChunk = currentChunk ? currentChunk + " " + sent : sent;
          } else {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = sent;
          }
        }
      } else {
        currentChunk = para;
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [clean.slice(0, targetChunkSize)];
}

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
    sdk.logger.debug(
      `Excluded page "${payload.url}": ${filter.reason}`,
    );
    return null;
  }

  const title = (payload.title || filter.domain || "Untitled Page").trim();
  sdk.logger.info(`[browser] [Phase 1: Chat Model] Preparing "${title}" (${filter.domain})`);
  let rawContent = (payload.textContent || payload.excerpt || title).trim();
  let parsedChunks: string[] | undefined;
  let contextualSummary: string | undefined;
  let imageChunks: Array<{
    text_content: string;
    chunk_type: "verbatim" | "synthetic";
  }> | undefined;
  // The page parser owns HTML/readability extraction, contextualization, and
  // image delegation. It is optional so browser ingestion remains usable when
  // this extension is intentionally not installed.
  try {
    const parsed = await sdk.messages.request<{
      text: string;
      chunks: string[];
      contextualSummary: string;
      imageChunks: Array<{
        text_content: string;
        chunk_type: "verbatim" | "synthetic";
      }>;
    }>("web:parse", {
      url: filter.cleanUrl,
      title,
      textContent: rawContent,
      html: payload.html,
      imageUrls: payload.images?.map((image) => image.url),
      includeImages: true,
    // Parsing may include local LLM and vision calls; allow the same cold-load
    // window used by Shale's local-model clients instead of timing out at 1.5s.
    }, { target: "web-page-parser", timeoutMs: 300000 });
    rawContent = parsed.text || rawContent;
    parsedChunks = parsed.chunks;
    contextualSummary = parsed.contextualSummary;
    imageChunks = parsed.imageChunks;
  } catch (error) {
    sdk.logger.debug(`Web-page parser unavailable for ${filter.cleanUrl}; using browser content: ${String(error)}`);
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
    sessionId: payload.sessionId,
  };

  // Phase 1 Chat Model Call: generate summary, topics, and category
  const checkpointId = `browser_page:${filter.cleanUrl}`;
  const analysis = await analyzePageWithLLM(sdk, pageData, settings);

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
      parsedChunks,
      contextualSummary,
      imageChunks,
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
    parsedChunks,
    contextualSummary,
    imageChunks,
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
  const { pageData, analysis, cleanUrl, domain, checkpointId, namespace } = prepared;
  const title = pageData.title;
  const rawContent = pageData.textContent;
  const visitedAt = pageData.visitedAt;

  sdk.logger.info(
    `[browser] [Phase 2: Embedding Model] Embedding and ingesting "${title}" (${domain})`,
  );

  // Phase 2 Chunking & Embeddings
  const chunkSize = settings.chunkSize ?? 1000;
  const rawChunks = prepared.parsedChunks?.length
    ? prepared.parsedChunks
    : chunkText(rawContent, chunkSize);

  const referenceLines = [
    ...(pageData.author ? [`Author: ${pageData.author}`] : []),
    ...(pageData.links ?? []).map((link) =>
      `Link: ${link.text?.trim() || link.url}\nURL: ${link.url}`
    ),
    ...(pageData.images ?? []).map((image) =>
      `Image: ${image.alt?.trim() || "Untitled image"}\nURL: ${image.url}`
    ),
  ];
  const referenceChunks = referenceLines.length
    ? chunkText(referenceLines.join("\n\n"), chunkSize)
    : [];

  const chunkRecords = [
    {
      text_content: `Page: ${title}\nDomain: ${domain}\nSummary: ${analysis.summary}\nContext: ${prepared.contextualSummary ?? ""}\nTopics: ${analysis.topics.join(", ")}`,
      chunk_type: "synthetic" as const,
    },
    ...rawChunks.map((text_content) => ({ text_content, chunk_type: "verbatim" as const })),
    ...referenceChunks.map((text_content) => ({ text_content, chunk_type: "verbatim" as const })),
    ...(prepared.imageChunks ?? []),
  ];
  const chunksToEmbed = chunkRecords.map((chunk) => chunk.text_content);

  const embeddings = await sdk.embed(chunksToEmbed);

  const sourceId = `web:${Buffer.from(cleanUrl).toString("base64url").slice(0, 64)}`;
  const sourceRes = sdk.ingest.sourceAndChunks({
    source: {
      id: sourceId,
      type: "web_page",
      uri: cleanUrl,
      origin: "browser",
      title,
      created_at: visitedAt,
      updated_at: visitedAt,
    },
    chunks: chunkRecords.map((chunk, i) => ({
      chunk_index: i,
      chunk_type: chunk.chunk_type,
      text_content: chunk.text_content,
      embedding: embeddings[i],
      entity_names: i === 0 ? [title, ...analysis.topics.slice(0, 3)] : undefined,
    })),
    namespace,
  });

  // Prepare Knowledge Graph Entities & Edges
  const entities: Array<{ name: string; type: string; namespace: string }> = [
    { name: title, type: "WebPage", namespace },
    { name: domain, type: "Domain", namespace },
  ];

  for (const topic of analysis.topics) {
    if (topic && topic !== title) {
      entities.push({ name: topic, type: "Topic", namespace });
    }
  }

  const edges: Array<{
    source: string;
    target: string;
    relation: string;
    weight: number;
    metadata?: any;
  }> = [
    {
      source: title,
      target: domain,
      relation: "BELONGS_TO_DOMAIN",
      weight: 1.0,
      metadata: { url: cleanUrl },
    },
  ];

  for (const topic of analysis.topics) {
    if (topic && topic !== title) {
      edges.push({
        source: title,
        target: topic,
        relation: "HAS_TOPIC",
        weight: 0.85,
      });
    }
  }

  // Session Grouping: record visit into active session
  const visitRecord: SessionVisitRecord = {
    url: cleanUrl,
    title,
    domain,
    visitedAt,
    tabId: pageData.tabId,
    transitionType: pageData.transitionType,
    pageSourceId: sourceRes.sourceId,
  };

  const sessionUpdate = await recordSessionVisit(
    sdk,
    visitRecord,
    pageData.sessionId,
    settings,
  );

  // If there is a sequential edge from previous page in session, link in graph
  if (sessionUpdate.sequentialEdge) {
    edges.push({
      source: sessionUpdate.sequentialEdge.source,
      target: sessionUpdate.sequentialEdge.target,
      relation: "NAVIGATED_TO",
      weight: 0.9,
      metadata: {
        transitionType: pageData.transitionType || "link",
        timestamp: visitedAt,
      },
    });
  }

  const graphRes = sdk.graph.ingest({
    namespace,
    entities,
    edges,
  });

  // Resolve checkpoint
  sdk.checkpoint.delete(checkpointId);

  return {
    sourceId: sourceRes.sourceId,
    chunkIds: sourceRes.chunkIds,
    entitiesCount: graphRes.entitiesInserted,
    edgesCount: graphRes.edgesInserted,
    summary: analysis.summary,
    topics: analysis.topics,
    category: analysis.category,
    sessionId: sessionUpdate.activeSession.sessionId,
  };
}

/**
 * Processes a single active web page visit through two-phase execution:
 * Phase 1: preparePageVisit (Chat model only, zero embeddings)
 * Phase 2: finalizePageVisit (Embedding model only, zero chat calls)
 */
export async function processPageVisit(
  sdk: ShaleSDK,
  payload: PageVisitPayload,
  settings: Partial<BrowserExtensionSettings>,
): Promise<IngestedPageResult | null> {
  const prepared = await preparePageVisit(sdk, payload, settings);
  if (!prepared) return null;
  return await finalizePageVisit(sdk, prepared, settings);
}

/**
 * Processes a batch of open tabs strictly enforcing the two-phase pipeline:
 * Phase 1: Prepares all tabs using Chat model (zero embeddings).
 * Phase 2: Embeds and commits all tabs using Embedding model (zero chat calls).
 * Exactly 1 GPU model transition occurs across the entire batch.
 */
export async function processTabsBatch(
  sdk: ShaleSDK,
  payload: TabsBatchPayload,
  settings: Partial<BrowserExtensionSettings>,
): Promise<{ ingestedCount: number; skippedCount: number }> {
  const pages = payload.pages || [];
  if (pages.length === 0) {
    return { ingestedCount: 0, skippedCount: 0 };
  }

  sdk.logger.info(
    `[browser] [Phase 1: Chat Model] Batch preparing ${pages.length} tab(s) with Chat model...`,
  );

  const preparedList: PreparedPageData[] = [];
  let skippedCount = 0;

  // Phase 1: Execute all Chat model operations across all tabs (Zero embeddings)
  for (const pagePayload of pages) {
    const prep = await preparePageVisit(sdk, pagePayload, settings);
    if (prep) {
      preparedList.push(prep);
    } else {
      skippedCount++;
    }
  }

  sdk.logger.info(
    `[browser] [Phase 1: Chat Model] Completed preparation of ${preparedList.length} tab(s). (Zero embeddings performed)`,
  );

  // Phase 2: Execute all Embedding model operations across all tabs (Zero chat calls)
  sdk.logger.info(
    `[browser] [Phase 2: Embedding Model] Batch ingesting and embedding ${preparedList.length} tab(s)...`,
  );

  for (const prep of preparedList) {
    await finalizePageVisit(sdk, prep, settings);
  }

  sdk.logger.info(
    `[browser] [Phase 2: Embedding Model] Completed ingestion of ${preparedList.length} tab(s). (Zero chat calls performed)`,
  );

  return { ingestedCount: preparedList.length, skippedCount };
}

/**
 * Processes a batch of browser history visits.
 */
export async function processHistoryBatch(
  sdk: ShaleSDK,
  payload: HistoryBatchPayload,
  settings: Partial<BrowserExtensionSettings>,
): Promise<{ ingestedCount: number; skippedCount: number }> {
  const namespace = settings.namespace || sdk.namespace || "browser";
  let skippedCount = 0;

  const validItems: Array<{
    title: string;
    filter: ReturnType<typeof evaluateUrl>;
    visitTime: number;
    visitCount?: number;
    textContent: string;
    sourceId: string;
  }> = [];

  for (const item of payload.items) {
    const filter = evaluateUrl(item.url, settings);
    if (!filter.allowed) {
      skippedCount++;
      continue;
    }

    const title = (item.title || filter.domain || "Historical Page").trim();
    const visitTime = item.visitTime || Date.now();
    const textContent = `Page: ${title}\nDomain: ${filter.domain}\nURL: ${filter.cleanUrl}\nVisited: ${new Date(
      visitTime,
    ).toISOString()}${item.visitCount ? `\nVisit Count: ${item.visitCount}` : ""}`;
    const sourceId = `history:${Buffer.from(filter.cleanUrl).toString("base64url").slice(0, 64)}`;

    validItems.push({
      title,
      filter,
      visitTime,
      visitCount: item.visitCount,
      textContent,
      sourceId,
    });
  }

  if (validItems.length === 0) {
    sdk.logger.info(
      `[History] 0 valid items in batch (${skippedCount} excluded/skipped).`,
    );
    return { ingestedCount: 0, skippedCount };
  }

  sdk.logger.info(
    `[History] Ingesting batch of ${validItems.length} items (${skippedCount} excluded/skipped)...`,
  );

  // Batch embed all items simultaneously
  const texts = validItems.map((v) => v.textContent);
  const embeddings = await sdk.embed(texts);

  const entities: Array<{ name: string; type: string; namespace: string }> = [];
  const edges: Array<{
    source: string;
    target: string;
    relation: string;
    weight: number;
    metadata?: any;
  }> = [];

  for (let i = 0; i < validItems.length; i++) {
    const v = validItems[i];
    sdk.ingest.sourceAndChunks({
      source: {
        id: v.sourceId,
        type: "browser_history",
        uri: v.filter.cleanUrl,
        origin: "browser",
        title: v.title,
        created_at: v.visitTime,
        updated_at: v.visitTime,
      },
      chunks: [
        {
          chunk_index: 0,
          chunk_type: "verbatim",
          text_content: v.textContent,
          embedding: embeddings[i],
          entity_names: [v.title, v.filter.domain],
        },
      ],
      namespace,
    });

    entities.push(
      { name: v.title, type: "WebPage", namespace },
      { name: v.filter.domain, type: "Domain", namespace },
    );

    edges.push({
      source: v.title,
      target: v.filter.domain,
      relation: "BELONGS_TO_DOMAIN",
      weight: 0.9,
      metadata: { visitCount: v.visitCount, lastVisit: v.visitTime },
    });
  }

  sdk.graph.ingest({
    namespace,
    entities,
    edges,
  });

  return { ingestedCount: validItems.length, skippedCount };
}

/**
 * Processes a batch of browser bookmarks.
 */
export async function processBookmarksBatch(
  sdk: ShaleSDK,
  payload: BookmarksBatchPayload,
  settings: Partial<BrowserExtensionSettings>,
): Promise<{ ingestedCount: number; skippedCount: number }> {
  const namespace = settings.namespace || sdk.namespace || "browser";
  let skippedCount = 0;

  const validItems: Array<{
    title: string;
    folder: string;
    filter: ReturnType<typeof evaluateUrl>;
    dateAdded: number;
    textContent: string;
    sourceId: string;
  }> = [];

  for (const item of payload.items) {
    if (!item.url) {
      skippedCount++;
      continue;
    }

    const filter = evaluateUrl(item.url, settings);
    if (!filter.allowed) {
      skippedCount++;
      continue;
    }

    const title = (item.title || filter.domain || "Bookmark").trim();
    const folder = (item.folderPath || "Bookmarks Bar").trim();
    const dateAdded = item.dateAdded || Date.now();
    const textContent = `Bookmark: ${title}\nFolder: ${folder}\nDomain: ${filter.domain}\nURL: ${filter.cleanUrl}`;
    const sourceId = `bookmark:${Buffer.from(filter.cleanUrl).toString("base64url").slice(0, 64)}`;

    validItems.push({
      title,
      folder,
      filter,
      dateAdded,
      textContent,
      sourceId,
    });
  }

  if (validItems.length === 0) {
    sdk.logger.info(
      `[Bookmarks] 0 valid items in batch (${skippedCount} excluded/skipped).`,
    );
    return { ingestedCount: 0, skippedCount };
  }

  sdk.logger.info(
    `[Bookmarks] Ingesting batch of ${validItems.length} bookmarks (${skippedCount} excluded/skipped)...`,
  );

  // Batch embed all items simultaneously
  const texts = validItems.map((v) => v.textContent);
  const embeddings = await sdk.embed(texts);

  const entities: Array<{ name: string; type: string; namespace: string }> = [];
  const edges: Array<{
    source: string;
    target: string;
    relation: string;
    weight: number;
    metadata?: any;
  }> = [];

  for (let i = 0; i < validItems.length; i++) {
    const v = validItems[i];
    sdk.ingest.sourceAndChunks({
      source: {
        id: v.sourceId,
        type: "bookmark",
        uri: v.filter.cleanUrl,
        origin: "browser",
        title: v.title,
        created_at: v.dateAdded,
        updated_at: v.dateAdded,
      },
      chunks: [
        {
          chunk_index: 0,
          chunk_type: "verbatim",
          text_content: v.textContent,
          embedding: embeddings[i],
          entity_names: [v.title, v.folder],
        },
      ],
      namespace,
    });

    entities.push(
      { name: v.title, type: "WebPage", namespace },
      { name: v.folder, type: "BookmarkFolder", namespace },
      { name: v.filter.domain, type: "Domain", namespace },
    );

    edges.push(
      {
        source: v.title,
        target: v.folder,
        relation: "BOOKMARKED_IN",
        weight: 1.0,
      },
      {
        source: v.title,
        target: v.filter.domain,
        relation: "BELONGS_TO_DOMAIN",
        weight: 1.0,
      },
    );
  }

  sdk.graph.ingest({
    namespace,
    entities,
    edges,
  });

  return { ingestedCount: validItems.length, skippedCount };
}

/**
 * Dispatches inbound browser payload to appropriate handler.
 */
export async function processBrowserPayload(
  sdk: ShaleSDK,
  payload: BrowserIngestPayload,
  settings: Partial<BrowserExtensionSettings>,
): Promise<any> {
  switch (payload.type) {
    case "page_visit":
    case "active_page":
      return processPageVisit(sdk, payload, settings);

    case "tabs_batch":
    case "pages_batch":
      return processTabsBatch(sdk, payload as TabsBatchPayload, settings);

    case "history_batch":
      return processHistoryBatch(sdk, payload, settings);

    case "bookmarks_batch":
      return processBookmarksBatch(sdk, payload, settings);

    case "session_snapshot":
    case "session_end":
      return ingestSessionSnapshot(sdk, payload, settings);

    case "ping":
      return { pong: true };

    default:
      sdk.logger.warn(
        `Unrecognized browser payload type: ${(payload as any)?.type}`,
      );
      return null;
  }
}
