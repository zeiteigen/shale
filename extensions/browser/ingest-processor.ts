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
  bookmarkSourceUri,
  browserSourceId,
  historySourceUri,
  pageEntityName,
  sanitizeTopics,
} from "./identity";
import {
  ingestSessionSnapshot,
  recordSessionVisit,
  finalizeSession,
} from "./session-manager";

/**
 * Splits text into chunks of target character size on sentence or paragraph boundaries.
 */
export function chunkText(
  text: string,
  targetChunkSize: number = 1000,
): string[] {
  const limit = Math.max(64, Math.floor(targetChunkSize));
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (!clean) return [""];
  if (clean.length <= limit) {
    return [clean];
  }

  const chunks: string[] = [];
  let currentChunk = "";
  const append = (piece: string) => {
    const value = piece.trim();
    if (!value) return;
    const separator = currentChunk ? " " : "";
    if (currentChunk.length + separator.length + value.length <= limit) {
      currentChunk += separator + value;
      return;
    }
    if (currentChunk) (chunks.push(currentChunk), (currentChunk = ""));
    if (value.length <= limit) {
      currentChunk = value;
      return;
    }

    // A DOM can contain enormous punctuation-free runs. Split those on words,
    // then hard-split any single token so the configured limit is guaranteed.
    for (const word of value.split(/\s+/)) {
      if (word.length > limit) {
        if (currentChunk) (chunks.push(currentChunk), (currentChunk = ""));
        for (let offset = 0; offset < word.length; offset += limit) {
          const part = word.slice(offset, offset + limit);
          if (part.length === limit) chunks.push(part);
          else currentChunk = part;
        }
      } else if (!currentChunk) {
        currentChunk = word;
      } else if (currentChunk.length + word.length + 1 <= limit) {
        currentChunk += ` ${word}`;
      } else {
        chunks.push(currentChunk);
        currentChunk = word;
      }
    }
  };

  for (const block of clean.split(/\n+/)) {
    for (const sentence of block.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [block])
      append(sentence);
  }
  if (currentChunk) chunks.push(currentChunk);
  return chunks.length > 0 ? chunks : [clean.slice(0, limit)];
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
    sdk.logger.debug(`Excluded page "${payload.url}": ${filter.reason}`);
    return null;
  }

  const title = (payload.title || filter.domain || "Untitled Page").trim();
  sdk.logger.info(
    `[browser] [Phase 1: Chat Model] Preparing "${title}" (${filter.domain})`,
  );
  let rawContent = (payload.textContent || payload.excerpt || title).trim();
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
    const parsed = await sdk.messages.request<{
      text: string;
      chunks: string[];
      contextualSummary: string;
      imageChunks: Array<{
        text_content: string;
        chunk_type: "verbatim" | "synthetic";
      }>;
    }>(
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
    rawContent = parsed.text || rawContent;
    parsedChunks = parsed.chunks;
    contextualSummary = parsed.contextualSummary;
    imageChunks = parsed.imageChunks;
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
    ...(prepared.imageChunks ?? []),
  ];
  const chunksToEmbed = chunkRecords.map((chunk) => chunk.text_content);

  const embeddings = await sdk.embed(chunksToEmbed);

  const sourceId = browserSourceId("web", cleanUrl);
  const pageEntity = pageEntityName(cleanUrl);
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
      entity_names: i === 0 ? [pageEntity, ...topics.slice(0, 3)] : undefined,
    })),
    namespace,
  });

  // Prepare Knowledge Graph Entities & Edges
  const entities: Array<{ name: string; type: string; namespace: string }> = [
    { name: pageEntity, type: "WebPage", namespace },
    { name: domain, type: "Domain", namespace },
  ];

  for (const topic of topics) {
    entities.push({ name: topic, type: "Topic", namespace });
  }

  const edges: Array<{
    source: string;
    target: string;
    relation: string;
    weight: number;
    metadata?: any;
  }> = [
    {
      source: pageEntity,
      target: domain,
      relation: "BELONGS_TO_DOMAIN",
      weight: 1.0,
      metadata: { url: cleanUrl },
    },
  ];

  for (const topic of topics) {
    edges.push({
      source: pageEntity,
      target: topic,
      relation: "HAS_TOPIC",
      weight: 0.85,
    });
  }

  // Session Grouping: record visit into active session
  const sessionUpdate = prepared.sessionUpdate;

  // If there is a sequential edge from previous page in session, link in graph
  if (sessionUpdate?.sequentialEdge) {
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
    category: analysis.category,
    topics,
    sessionId: sessionUpdate?.activeSession.sessionId,
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
  return sdk.models.batch(
    () => preparePageVisit(sdk, payload, settings),
    (prepared) =>
      prepared
        ? finalizePageVisit(sdk, prepared, settings)
        : Promise.resolve(null),
  );
}

/**
 * Processes a batch of open tabs strictly enforcing the two-phase pipeline:
 * Phase 1: Prepares all tabs using Chat model (zero embeddings).
 * Phase 2: Embeds and commits all tabs using Embedding model (zero chat calls).
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

  return sdk.models.batch(
    async () => {
      const preparedList: PreparedPageData[] = [];
      let skippedCount = 0;
      for (const page of pages) {
        const prepared = await preparePageVisit(sdk, page, settings);
        if (prepared) preparedList.push(prepared);
        else skippedCount++;
      }
      return { preparedList, skippedCount };
    },
    async ({ preparedList, skippedCount }) => {
      for (const prepared of preparedList)
        await finalizePageVisit(sdk, prepared, settings);
      return { ingestedCount: preparedList.length, skippedCount };
    },
  );
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
    sourceUri: string;
    pageEntity: string;
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
    const sourceId = browserSourceId("history", filter.cleanUrl);

    validItems.push({
      title,
      filter,
      visitTime,
      visitCount: item.visitCount,
      textContent,
      sourceId,
      sourceUri: historySourceUri(filter.cleanUrl),
      pageEntity: pageEntityName(filter.cleanUrl),
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
        uri: v.sourceUri,
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
          entity_names: [v.pageEntity, v.filter.domain],
        },
      ],
      namespace,
    });

    entities.push(
      { name: v.pageEntity, type: "WebPage", namespace },
      { name: v.filter.domain, type: "Domain", namespace },
    );

    edges.push({
      source: v.pageEntity,
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
    sourceUri: string;
    pageEntity: string;
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
    const sourceUri = bookmarkSourceUri(item.id, filter.cleanUrl);
    const sourceId = browserSourceId("bookmark", sourceUri);

    validItems.push({
      title,
      folder,
      filter,
      dateAdded,
      textContent,
      sourceId,
      sourceUri,
      pageEntity: pageEntityName(filter.cleanUrl),
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
        uri: v.sourceUri,
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
          entity_names: [v.pageEntity, v.folder],
        },
      ],
      namespace,
    });

    entities.push(
      { name: v.pageEntity, type: "WebPage", namespace },
      { name: v.folder, type: "BookmarkFolder", namespace },
      { name: v.filter.domain, type: "Domain", namespace },
    );

    edges.push(
      {
        source: v.pageEntity,
        target: v.folder,
        relation: "BOOKMARKED_IN",
        weight: 1.0,
      },
      {
        source: v.pageEntity,
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
