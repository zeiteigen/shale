import { rememberCapture } from "./capture-store";
import type { ShaleSDK } from "@shale/sdk";
import type { WebPageParseResponse } from "../../lib/messages/web-contracts";
import { contentFingerprint, memoryChunks, prepareSourceMemory } from "../../lib/memory/prepare";
import type {
  PageVisitPayload,
  PreparedPageData,
  WebPageData,
  IngestedPageResult,
} from "./types";
import type { BrowserExtensionSettings } from "./settings.types";
import { ensureBrowserSchema } from "./storage-schema";
import { fingerprint, finishJob } from "./inbox-store";
import { evaluateUrl } from "./filter";
import { analyzePageWithLLM } from "./llm-enricher";
import { browserSourceId, sanitizeTopics } from "./identity";
import { recordSessionVisit } from "./session-manager";
import { finalizeSession } from "./session-ingest";
import { commitPageGraph } from "./page-graph";
import { isSourceExcluded } from "../../lib/knowledge/exclusions";
import { sourceRefreshScope } from '../../lib/memory/refresh-scope';

/**
 * Prepare a web page using chat analysis and checkpoints.
 */
export async function preparePageVisit(
  sdk: ShaleSDK,
  payload: PageVisitPayload,
  settings: Partial<BrowserExtensionSettings>,
  options: { jobId?: string; managed?: boolean; parsed?: WebPageParseResponse } = {},
): Promise<PreparedPageData | null> {
  const filter = evaluateUrl(payload.url, settings);
  if (payload.incognito && settings.excludePrivateBrowsing !== false)
    return null;
  if (!filter.allowed) {
    sdk.logger.debug(`Excluded page "${payload.url}": ${filter.reason}`);
    return null;
  }

  const title = (payload.title || filter.domain || "Untitled Page").trim();
  sdk.logger.info(
    `[browser] Preparing "${title}" (${filter.domain})`,
  );
  ensureBrowserSchema(sdk.database);
  const contentKey = fingerprint([
    "page-analysis-v2",
    filter.cleanUrl,
    payload.textContent,
    payload.blocks,
    payload.html,
    payload.title,
    payload.author,
    payload.links,
    payload.images,
    payload.extraction,
    settings.enableLlmAnalysis,
    settings.enableImageAnalysis,
    settings.extractTopics,
    settings.maxContentChars,
    settings.minContentLength,
    settings.chunkSize,
    settings.llmModel,
    settings.namespace,
    payload.captureOrigin,
    sdk.llm.options?.().model,
  ]);
  const checkpointId =
    options.jobId ??
    `browser_page:${filter.cleanUrl}:${payload.recordId || payload.eventId || payload.visitedAt || crypto.randomUUID()}`;
  const cacheRow = sourceRefreshScope() ? null : sdk.database
    .query<{ prepared: string; source_id: string | null; updated_at: number }, [string, string]>(
      "SELECT prepared,source_id,updated_at FROM browser_content_cache WHERE extension_id=? AND content_key=?",
    ).get(sdk.extensionId, contentKey);
  const cachedData = cacheRow ? JSON.parse(cacheRow.prepared) as any : null;
  const staged = !!cachedData?.memory && cachedData.cacheState === "staged" &&
    cacheRow!.updated_at >= Date.now() - 24 * 60 * 60 * 1000;
  let cachedMemory: PreparedPageData["memory"] | undefined;
  let cachedAnalysis: PreparedPageData["analysis"] | undefined;
  let cached = staged ? cacheRow : null;
  if (cacheRow && cachedData?.cacheState === "complete" && cacheRow.source_id) {
    try {
      const retained = sdk.memory.get(cacheRow.source_id);
      if (retained.freshness.fingerprint === cachedData.sourceFingerprint) {
        cachedMemory = {
          summary: retained.summary.text,
          summaryMethod: retained.summary.method,
          snippets: retained.snippets.map(({ text, kind, locator, purpose, id }) => ({ text, kind, locator, purpose, id })),
          coverage: retained.coverage,
        };
        cachedAnalysis = { summary: cachedMemory.summary,
          topics: cachedData.graphMetadata?.topics ?? [],
          category: cachedData.graphMetadata?.category ?? "general" };
        cached = cacheRow;
      }
    } catch { /* Missing retained memory makes the receipt unusable for reuse. */ }
  }
  if (cacheRow && !cached) sdk.database
    .query("DELETE FROM browser_content_cache WHERE extension_id=? AND content_key=?")
    .run(sdk.extensionId, contentKey);
  const stagedData = staged ? cachedData as PreparedPageData : undefined;
  let rawContent = (payload.textContent || payload.excerpt || title).trim();
  let parser: WebPageParseResponse | undefined = options.parsed;
  // The page parser owns HTML/readability extraction, contextualization, and
  // image delegation. It is optional so browser ingestion remains usable when
  // this extension is intentionally not installed.
  try {
    if (parser) rawContent = parser.text || rawContent;
    else {
    if (cached) throw new Error("Using cached parser output");
    const parsed = await sdk.messages.request(
      "web:parse",
      {
        url: filter.cleanUrl,
        title,
        textContent: rawContent,
        html: payload.html,
        imageUrls: payload.images?.map((image) => image.url),
        includeImages: settings.enableImageAnalysis === true,
        enableLlmContext: false,
        blocks: payload.blocks,
        extraction: payload.extraction,
        chunkSize: settings.chunkSize,
        // Parsing may include local LLM and vision calls; allow the same cold-load
        // window used by Shale's local-model clients instead of timing out at 1.5s.
      },
      { target: "web-page-parser", timeoutMs: 300000 },
    );
    parser = parsed;
    rawContent = parsed.text || rawContent;
    }
  } catch (error) {
    sdk.logger.debug(
      `Web-page parser unavailable for ${filter.cleanUrl}; using browser content: ${String(error)}`,
    );
  }
  if (cached) {
    const previous = stagedData;
    const previousMemory = cachedMemory ?? previous!.memory;
    parser = {
      title,
      text: previousMemory.snippets.map((snippet) => snippet.text).join("\n\n"),
      chunks: [],
      contextualSummary: previousMemory.summary,
      imageUrls: [],
      imageChunks: [],
      extraction: cachedData.extraction ?? previous?.extraction,
      imageKnowledge: previous?.imageKnowledge,
    };
    rawContent = parser.text;
  }
  const visitedAt = payload.visitedAt || Date.now();
  const namespace = settings.namespace || sdk.namespace || "browser";

  const rawPageData: WebPageData = {
    recordId: payload.recordId,
    collectorId: payload.collectorId,
    eventId: payload.eventId,
    sequence: payload.sequence,
    documentId: payload.documentId,
    browserInstanceId: payload.browserInstanceId,
    incognito: payload.incognito,
    goal: payload.goal,
    tabGroup: payload.tabGroup,
    captureOrigin: payload.captureOrigin,
    url: payload.url,
    cleanUrl: filter.cleanUrl,
    domain: filter.domain,
    title,
    textContent: rawContent,
    excerpt: payload.excerpt || rawContent.slice(0, 300),
    favIconUrl: payload.favIconUrl,
    author: payload.author,
    links: payload.links?.slice(0, 100).map((link) => ({
      url: link.url.slice(0, 2000),
      text: link.text?.slice(0, 300),
      rel: link.rel?.slice(0, 80),
    })),
    images: payload.images?.slice(0, 8).map((image) => ({
      url: image.url.slice(0, 2000),
      alt: image.alt?.slice(0, 300),
      width: image.width,
      height: image.height,
    })),
    visitedAt,
    tabId: payload.tabId,
    windowId: payload.windowId,
    openerTabId: payload.openerTabId,
    transitionType: payload.transitionType,
    recordInSession: payload.recordInSession,
    sessionId: payload.sessionId,
  };

  // Chat model request: generate summary, topics, and category
  const analysis = cached
    ? cachedAnalysis ?? stagedData!.analysis
    : await analyzePageWithLLM(sdk, rawPageData, settings);
  const pageChunks = parser?.chunks?.length
    ? parser.chunks.map((text_content, chunk_index) => ({
        text_content,
        chunk_type: "verbatim" as const,
        chunk_index,
        metadata: parser?.chunkLocators?.[chunk_index],
      }))
    : [{ text_content: rawContent, chunk_type: "verbatim" as const, chunk_index: 0 }];
  const imageChunks = parser?.imageChunks.map((chunk, index) => ({
    text_content: chunk.text_content,
    chunk_type: "synthetic" as const,
    chunk_index: pageChunks.length + index,
    metadata: chunk.metadata,
  })) ?? [];
  const memory = cached
    ? cachedMemory ?? stagedData!.memory
    : prepareSourceMemory([...pageChunks, ...imageChunks], {
        title,
        summary: analysis.summary,
      });
  const sourceFingerprint = cached
    ? cachedData.sourceFingerprint
    : contentFingerprint([{text_content:rawContent,chunk_type:'verbatim'}]);
  const pageData: WebPageData = {
    ...rawPageData,
    textContent: memory.snippets
      .filter((snippet) => snippet.kind === "excerpt")
      .map((snippet) => snippet.text)
      .join("\n\n"),
    excerpt: memory.summary.slice(0, 300),
  };
  const sessionUpdate =
    options.managed || pageData.recordInSession === false
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
      jobId: options.jobId,
      contentKey,
      pageData,
      analysis,
      memory,
      sourceFingerprint,
      namespace,
      extraction: parser?.extraction ?? payload.extraction,
      imageKnowledge: parser?.imageKnowledge,
      imageOffset: pageChunks.length,
      sessionUpdate,
    },
    { id: checkpointId, key: checkpointId },
  );

  const prepared: PreparedPageData = {
    jobId: options.jobId,
    contentKey,
    canonicalSourceId: browserSourceId("web", filter.cleanUrl),
    memory,
    sourceFingerprint,
    pageData,
    analysis,
    cleanUrl: filter.cleanUrl,
    domain: filter.domain,
    checkpointId,
    namespace,
    extraction: parser?.extraction ?? payload.extraction,
    imageKnowledge: parser?.imageKnowledge,
    imageOffset: pageChunks.length,
    sessionUpdate,
  };
  if (!cachedMemory) sdk.database
    .query(
      `INSERT INTO browser_content_cache VALUES(?,?,?,?,?) ON CONFLICT(extension_id,content_key)
    DO UPDATE SET prepared=excluded.prepared,updated_at=excluded.updated_at`,
    )
    .run(
      sdk.extensionId,
      contentKey,
      JSON.stringify({ ...prepared, cacheState: "staged", settings: undefined, sessionUpdate: null }),
      null,
      Date.now(),
    );
  rememberCapture(
    sdk,
    prepared,
    browserSourceId("web", filter.cleanUrl),
  );
  pruneContentCache(sdk, prepared.canonicalSourceId!);
  return prepared;
}

function pruneContentCache(sdk: ShaleSDK, sourceId: string, now = Date.now()): void {
  const cutoff = now - 24 * 60 * 60 * 1000;
  sdk.database.query(`DELETE FROM browser_content_cache WHERE extension_id=? AND updated_at<?
    AND coalesce(json_extract(prepared,'$.cacheState'),'staged')!='complete'`).run(sdk.extensionId, cutoff);
  sdk.database.query(`DELETE FROM browser_content_cache WHERE extension_id=?
    AND json_extract(prepared,'$.canonicalSourceId')=? AND content_key NOT IN (
      SELECT content_key FROM browser_content_cache WHERE extension_id=?
      AND json_extract(prepared,'$.canonicalSourceId')=? ORDER BY updated_at DESC,content_key DESC LIMIT 32)`)
    .run(sdk.extensionId, sourceId, sdk.extensionId, sourceId);
}

/**
 * Commit prepared page chunks and graph evidence to SQLite.
 */
export async function finalizePageVisit(
  sdk: ShaleSDK,
  prepared: PreparedPageData,
  settings: Partial<BrowserExtensionSettings>,
  assertOwned: () => void = () => {},
): Promise<IngestedPageResult> {
  const legacy = prepared as PreparedPageData & {
    parsedChunks?: string[];
    parser?: WebPageParseResponse;
  };
  if (!prepared.memory) {
    const sourceChunks = legacy.parsedChunks?.length
      ? legacy.parsedChunks
      : [prepared.pageData.textContent ?? ""];
    prepared.memory = prepareSourceMemory(
      sourceChunks.map((text_content, chunk_index) => ({
        text_content,
        chunk_index,
        metadata: legacy.parser?.chunkLocators?.[chunk_index],
      })),
      { title: prepared.pageData.title, summary: prepared.analysis.summary },
    );
    prepared.pageData = {
      ...prepared.pageData,
      textContent: prepared.memory.snippets
        .filter((snippet) => snippet.kind === "excerpt")
        .map((snippet) => snippet.text)
        .join("\n\n"),
      excerpt: prepared.memory.summary.slice(0, 300),
    };
    prepared.extraction ??= legacy.parser?.extraction;
    prepared.imageKnowledge ??= legacy.parser?.imageKnowledge;
    prepared.imageOffset ??= legacy.parsedChunks?.length ?? 0;
    delete (prepared as any).parser;
    delete (prepared as any).parsedChunks;
    delete (prepared as any).contextualSummary;
    delete (prepared as any).imageChunks;
  }
  const { pageData, analysis, cleanUrl, domain, checkpointId, namespace } =
    prepared;
  const sourceId = browserSourceId("web", cleanUrl);
  const sourceUri = cleanUrl;
  if (
    isSourceExcluded(sdk.database, sourceId, sourceUri)
  ) {
    if (prepared.jobId) finishJob(sdk, prepared.jobId, { sourceId, skipped: "excluded" });
    else sdk.checkpoint.delete(checkpointId);
    return {
      sourceId, chunkIds: [], entitiesCount: 0, edgesCount: 0,
      summary: analysis.summary, topics: [], category: analysis.category,
      sessionId: prepared.sessionUpdate?.activeSession.sessionId,
    };
  }
  if (prepared.sessionUpdate?.preparedSession) {
    await finalizeSession(
      sdk,
      prepared.sessionUpdate.preparedSession,
      settings,
    );
  }
  const cache = prepared.contentKey
    ? sdk.database
        .query<
          { prepared: string; source_id: string | null },
          [string, string]
        >(
          "SELECT prepared,source_id FROM browser_content_cache WHERE extension_id=? AND content_key=?",
        )
        .get(sdk.extensionId, prepared.contentKey)
    : null;
  const cachedHash = cache
    ? (JSON.parse(cache.prepared) as PreparedPageData).indexedHash
    : undefined;
  const currentHash = cache?.source_id
    ? sdk.database
        .query<{ hash: string }, [string]>(
          "SELECT hash FROM sources WHERE id=?",
        )
        .get(cache.source_id)?.hash
    : undefined;
  const canonicalType = "web_page";
  const capturedAt = pageData.capturedAt ?? pageData.visitedAt;
  const current = sdk.database
    .query<{ hash: string; updated_at: number }, [string]>(
      "SELECT hash,updated_at FROM sources WHERE id=?",
    )
    .get(sourceId);
  const newest = !current || capturedAt >= current.updated_at;
  const observedQuality=current ? sdk.database.query<{quality:string|null},[string]>(`SELECT json_extract(metadata,'$.quality') AS quality
    FROM source_observations WHERE source_id=? AND json_extract(metadata,'$.quality') IS NOT NULL ORDER BY captured_at DESC,id DESC LIMIT 1`).get(sourceId)?.quality : null;
  const currentQuality = observedQuality ?? (current
    ? sdk.database.query<{ quality: string | null }, [string, string, string]>(
        `SELECT coalesce(json_extract(prepared,'$.extraction.quality'),json_extract(prepared,'$.parser.extraction.quality')) AS quality
        FROM browser_content_cache WHERE extension_id=? AND source_id=?
          AND json_extract(prepared,'$.indexedHash')=? ORDER BY updated_at DESC LIMIT 1`,
      ).get(sdk.extensionId, sourceId, current.hash)?.quality
    : null);
  const qualityRank = { metadata: 0, partial: 1, full: 2 } as const;
  const incomingQuality = prepared.extraction?.quality ?? "metadata";
  const lowerQuality = !!currentQuality &&
    (qualityRank[currentQuality as keyof typeof qualityRank] ?? 0) >
      qualityRank[incomingQuality];
  if (cachedHash && cachedHash === currentHash && cache?.source_id === sourceId) {
    assertOwned();
    writeCompletedReceipt(sdk, prepared, sourceId, currentHash!, analysis);
    rememberCapture(sdk, prepared, sourceId);
    if (prepared.jobId) finishJob(sdk, prepared.jobId, { sourceId, reused: true });
    else sdk.checkpoint.delete(checkpointId);
    const result = sdk.database.query<{ id: number }, [string]>(
      "SELECT id FROM chunks WHERE source_id=? ORDER BY chunk_index",
    ).all(sourceId);
    return {
      sourceId,
      chunkIds: result.map((row) => row.id),
      entitiesCount: 0,
      edgesCount: 0,
      ...analysis,
    };
  }
  if ((!newest || lowerQuality) && current) {
    assertOwned();
    rememberCapture(sdk, prepared, sourceId);
    // This capture did not become canonical memory. Do not let its quality or
    // provenance replace the receipt for the retained source revision.
    if (prepared.contentKey) sdk.database.query(
      "DELETE FROM browser_content_cache WHERE extension_id=? AND content_key=?",
    ).run(sdk.extensionId, prepared.contentKey);
    if (prepared.jobId) finishJob(sdk, prepared.jobId, {
      sourceId,
      stale: !newest,
      lowerQuality,
    });
    else sdk.checkpoint.delete(checkpointId);
    const result = sdk.database.query<{ id: number }, [string]>(
      "SELECT id FROM chunks WHERE source_id=? ORDER BY chunk_index",
    ).all(sourceId);
    return { sourceId, chunkIds: result.map((row) => row.id), entitiesCount: 0,
      edgesCount: 0, ...analysis };
  }
  const title = pageData.title;
  const visitedAt = pageData.visitedAt;

  sdk.logger.info(
    `[browser] Ingesting "${title}" (${domain})`,
  );

  // Build stored text chunks.
  const chunks = memoryChunks(prepared.memory);
  const topics =
    settings.extractTopics === false
      ? []
      : sanitizeTopics(analysis.topics, { title, domain });

  assertOwned();
  const { sourceRes, graphRes } = sdk.database.transaction(() => {
    const sourceRes = sdk.ingest.sourceAndChunks({
      namespace,
      source: {
        id: sourceId,
        type: canonicalType,
        uri: sourceUri,
        origin: "browser",
        title,
        hash: prepared.sourceFingerprint,
        observation:{captureOrigin:pageData.captureOrigin ?? 'live-dom',quality:prepared.extraction?.quality ?? 'metadata'},
        created_at: capturedAt,
        updated_at: capturedAt,
      },
      chunks,
      memory: prepared.memory,
    });
    if (sourceRes.skipped) {
      if (prepared.jobId) finishJob(sdk, prepared.jobId, { sourceId, skipped: "excluded" });
      else sdk.checkpoint.delete(checkpointId);
      return { sourceRes, graphRes: { entitiesInserted: 0, edgesInserted: 0 } };
    }
    const indexedId = sourceRes.sourceId;
    const graph = commitPageGraph(
      sdk,
      sourceRes.sourceId,
      prepared,
      topics,
      prepared.imageOffset ?? 0,
    );
    const indexedHash = sdk.database
      .query<{ hash: string }, [string]>("SELECT hash FROM sources WHERE id=?")
      .get(indexedId)!.hash;
    writeCompletedReceipt(sdk, prepared, indexedId, indexedHash, analysis);
    rememberCapture(sdk, prepared, indexedId);
    if (prepared.jobId)
      finishJob(sdk, prepared.jobId, { sourceId });
    else sdk.checkpoint.delete(checkpointId);
    return {
      sourceRes,
      graphRes: {
        entitiesInserted: graph.entities.size,
        edgesInserted: graph.edgesCount,
      },
    };
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

function writeCompletedReceipt(
  sdk: ShaleSDK,
  prepared: PreparedPageData,
  sourceId: string,
  indexedHash: string,
  analysis: PreparedPageData["analysis"],
): void {
  if (!prepared.contentKey) return;
  const receipt = {
    cacheState: "complete",
    sourceFingerprint: prepared.sourceFingerprint,
    indexedHash,
    canonicalSourceId: sourceId,
    captureOrigin: prepared.pageData.captureOrigin ?? "live-dom",
    extraction: prepared.extraction,
    graphMetadata: { topics: analysis.topics.slice(0, 20), category: analysis.category },
  };
  sdk.database.query(`INSERT INTO browser_content_cache VALUES(?,?,?,?,?)
    ON CONFLICT(extension_id,content_key) DO UPDATE SET source_id=excluded.source_id,
    prepared=excluded.prepared,updated_at=excluded.updated_at`)
    .run(sdk.extensionId, prepared.contentKey, JSON.stringify(receipt), sourceId, Date.now());
  pruneContentCache(sdk, sourceId);
}
