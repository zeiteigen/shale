import { contentVersion, copyIndexedContent } from "./content-version";
import { rememberCapture } from "./capture-store";
import { embedBounded } from "./embed-bounded";
import type { ShaleSDK } from "@shale/sdk";
import type { WebPageParseResponse } from "../../lib/messages/web-contracts";
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
import { chunkText } from "./chunk-text";
import { commitPageGraph } from "./page-graph";
import { isSourceExcluded } from "../../lib/knowledge/exclusions";

/**
 * Phase 1: Discovers and prepares a web page using Chat model analysis and checkpoints.
 * Zero embedding calls happen in this phase, keeping the Chat model loaded in GPU memory.
 */
export async function preparePageVisit(
  sdk: ShaleSDK,
  payload: PageVisitPayload,
  settings: Partial<BrowserExtensionSettings>,
  options: { jobId?: string; managed?: boolean } = {},
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
    `[browser] [Phase 1: Chat Model] Preparing "${title}" (${filter.domain})`,
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
    sdk.embedder.options?.().model,
  ]);
  const checkpointId =
    options.jobId ??
    `browser_page:${filter.cleanUrl}:${payload.recordId || payload.eventId || payload.visitedAt || crypto.randomUUID()}`;
  const cached = sdk.database
    .query<{ prepared: string; source_id: string | null }, [string, string]>(
      "SELECT prepared,source_id FROM browser_content_cache WHERE extension_id=? AND content_key=?",
    )
    .get(sdk.extensionId, contentKey);
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
    parsedChunks = parsed.chunks;
    contextualSummary = parsed.contextualSummary;
    imageChunks = parsed.imageChunks.map((chunk) => ({
      ...chunk,
      chunk_type: "synthetic",
    }));
  } catch (error) {
    sdk.logger.debug(
      `Web-page parser unavailable for ${filter.cleanUrl}; using browser content: ${String(error)}`,
    );
  }
  if (cached) {
    const previous = JSON.parse(cached.prepared) as PreparedPageData;
    parser = previous.parser;
    rawContent = previous.pageData.textContent;
    parsedChunks = previous.parsedChunks;
    contextualSummary = previous.contextualSummary;
    imageChunks = previous.imageChunks;
  }
  const visitedAt = payload.visitedAt || Date.now();
  const namespace = settings.namespace || sdk.namespace || "browser";

  const pageData: WebPageData = {
    ...payload,
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
  const analysis = cached
    ? (JSON.parse(cached.prepared) as PreparedPageData).analysis
    : await analyzePageWithLLM(sdk, pageData, settings);
  contextualSummary ||= analysis.summary;
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
      settings,
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

  const prepared: PreparedPageData = {
    jobId: options.jobId,
    contentKey,
    settings,
    canonicalSourceId: browserSourceId(
      payload.captureOrigin === "public-fetch" ? "public" : "web",
      filter.cleanUrl,
    ),
    indexedHash: cached
      ? (JSON.parse(cached.prepared) as PreparedPageData).indexedHash
      : undefined,
    reused:
      !!cached?.source_id &&
      sdk.database
        .query<{ hash: string }, [string]>(
          "SELECT hash FROM sources WHERE id=?",
        )
        .get(cached.source_id)?.hash ===
        (JSON.parse(cached.prepared) as PreparedPageData).indexedHash,
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
  sdk.database
    .query(
      `INSERT INTO browser_content_cache VALUES(?,?,?,?,?) ON CONFLICT(extension_id,content_key)
    DO UPDATE SET prepared=excluded.prepared,updated_at=excluded.updated_at`,
    )
    .run(
      sdk.extensionId,
      contentKey,
      JSON.stringify(prepared),
      cached?.source_id ?? null,
      Date.now(),
    );
  rememberCapture(
    sdk,
    prepared,
    contentVersion(prepared)?.id ?? browserSourceId("web", filter.cleanUrl),
  );
  return prepared;
}

/**
 * Phase 2: Embeds prepared page chunks with the Embedding model and commits
 * sources, chunks, and graph edges to SQLite. Zero Chat model calls happen in this phase.
 */
export async function finalizePageVisit(
  sdk: ShaleSDK,
  prepared: PreparedPageData,
  settings: Partial<BrowserExtensionSettings>,
  assertOwned: () => void = () => {},
): Promise<IngestedPageResult> {
  const { pageData, analysis, cleanUrl, domain, checkpointId, namespace } =
    prepared;
  const sourceId = browserSourceId(
    pageData.captureOrigin === "public-fetch" ? "public" : "web",
    cleanUrl,
  );
  const sourceUri =
    pageData.captureOrigin === "public-fetch"
      ? `browser-public://${encodeURIComponent(cleanUrl)}`
      : cleanUrl;
  const version = contentVersion(prepared);
  if (
    isSourceExcluded(sdk.database, sourceId, sourceUri) ||
    (version && isSourceExcluded(sdk.database, version.id, version.uri))
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
  const canonicalType =
    pageData.captureOrigin === "public-fetch" ? "public_web_page" : "web_page";
  const capturedAt = pageData.capturedAt ?? pageData.visitedAt;
  const current = sdk.database
    .query<{ hash: string; updated_at: number }, [string]>(
      "SELECT hash,updated_at FROM sources WHERE id=?",
    )
    .get(sourceId);
  const newest = !current || capturedAt >= current.updated_at;
  if (cachedHash && cachedHash === currentHash) {
    assertOwned();
    const result = sdk.database.transaction(() => {
      let indexedId = cache!.source_id!;
      if (version && indexedId !== version.id) {
        copyIndexedContent(sdk, indexedId, version, prepared);
        indexedId = version.id;
      }
      if (newest && current?.hash !== cachedHash) {
        const restored = copyIndexedContent(
          sdk,
          indexedId,
          { id: sourceId, uri: sourceUri, type: canonicalType },
          prepared,
        );
        commitPageGraph(
          sdk,
          sourceId,
          prepared,
          sanitizeTopics(analysis.topics, { title: pageData.title, domain }),
          restored.chunkIds.length - (prepared.imageChunks?.length ?? 0),
        );
      } else if (newest)
        sdk.database
          .query("UPDATE sources SET updated_at=max(updated_at,?) WHERE id=?")
          .run(capturedAt, sourceId);
      rememberCapture(sdk, prepared, indexedId);
      sdk.database
        .query(
          "UPDATE browser_content_cache SET source_id=?,prepared=? WHERE extension_id=? AND content_key=?",
        )
        .run(
          indexedId,
          JSON.stringify({
            ...prepared,
            canonicalSourceId: sourceId,
            indexedHash: cachedHash,
          }),
          sdk.extensionId,
          prepared.contentKey!,
        );
      if (prepared.jobId)
        finishJob(sdk, prepared.jobId, {
          sourceId,
          versionSourceId: indexedId,
          reused: true,
        });
      else sdk.checkpoint.delete(checkpointId);
      return sdk.database
        .query<{ id: number }, [string]>(
          "SELECT id FROM chunks WHERE source_id=? ORDER BY chunk_index",
        )
        .all(newest ? sourceId : indexedId);
    })();
    return {
      sourceId,
      chunkIds: result.map((row) => row.id),
      entitiesCount: 0,
      edgesCount: 0,
      ...analysis,
    };
  }
  const title = pageData.title;
  const rawContent = pageData.textContent;
  const visitedAt = pageData.visitedAt;

  sdk.logger.info(
    `[browser] [Phase 2: Embedding Model] Embedding and ingesting "${title}" (${domain})`,
  );

  // Phase 2 Chunking & Embeddings
  const chunkSize = settings.chunkSize ?? 1000;
  const rawChunks = (
    prepared.parsedChunks?.length
      ? prepared.parsedChunks
      : chunkText(rawContent, chunkSize)
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
    {
      text_content: JSON.stringify(
        {
          url: cleanUrl,
          title,
          domain,
          author: pageData.author,
          captureOrigin: pageData.captureOrigin,
          ...(prepared.jobId
            ? { extraction: prepared.parser?.extraction }
            : {
                visitedAt,
                tabId: pageData.tabId,
                windowId: pageData.windowId,
                openerTabId: pageData.openerTabId,
                transitionType: pageData.transitionType,
                sessionId: pageData.sessionId,
              }),
          links: pageData.links,
          images: pageData.images,
        },
        null,
        2,
      ),
      chunk_type: "verbatim" as const,
    },
    ...(prepared.imageChunks ?? []).map((chunk) => ({
      ...chunk,
      chunk_type: "synthetic" as const,
    })),
  ];
  const chunksToEmbed = chunkRecords.map((chunk) => chunk.text_content);

  const embeddings = await embedBounded(
    sdk,
    chunksToEmbed,
    settings,
    assertOwned,
  );

  assertOwned();
  const { sourceRes, graphRes } = sdk.database.transaction(() => {
    const chunks = chunkRecords.map((chunk, i) => ({
      ...chunk,
      chunk_index: i,
      embedding: embeddings[i],
    }));
    const immutable = version
      ? sdk.ingest.sourceAndChunks({
          namespace,
          source: {
            ...version,
            origin: "browser",
            title,
            created_at: capturedAt,
            updated_at: capturedAt,
          },
          chunks,
        })
      : null;
    if (immutable?.skipped) {
      if (prepared.jobId) finishJob(sdk, prepared.jobId, { sourceId, skipped: "excluded" });
      else sdk.checkpoint.delete(checkpointId);
      return { sourceRes: immutable, graphRes: { entitiesInserted: 0, edgesInserted: 0 } };
    }
    const sourceRes =
      newest || !immutable
        ? sdk.ingest.sourceAndChunks({
            namespace,
            source: {
              id: sourceId,
              type: canonicalType,
              hash: immutable
                ? sdk.database
                    .query<{ hash: string }, [string]>(
                      "SELECT hash FROM sources WHERE id=?",
                    )
                    .get(immutable.sourceId)!.hash
                : undefined,
              uri: sourceUri,
              origin: "browser",
              title,
              created_at: capturedAt,
              updated_at: capturedAt,
            },
            chunks,
          })
        : immutable;
    if (sourceRes.skipped) {
      if (prepared.jobId) finishJob(sdk, prepared.jobId, { sourceId, skipped: "excluded" });
      else sdk.checkpoint.delete(checkpointId);
      return { sourceRes, graphRes: { entitiesInserted: 0, edgesInserted: 0 } };
    }
    const indexedId = immutable?.sourceId ?? sourceRes.sourceId;
    const imageOffset = 2 + rawChunks.length + referenceChunks.length;
    const graph = commitPageGraph(
      sdk,
      sourceRes.sourceId,
      prepared,
      topics,
      imageOffset,
    );
    if (prepared.contentKey)
      sdk.database
        .query(
          `INSERT INTO browser_content_cache VALUES(?,?,?,?,?)
      ON CONFLICT(extension_id,content_key) DO UPDATE SET source_id=excluded.source_id,prepared=excluded.prepared,updated_at=excluded.updated_at`,
        )
        .run(
          sdk.extensionId,
          prepared.contentKey,
          JSON.stringify({
            ...prepared,
            canonicalSourceId: sourceId,
            indexedHash: sdk.database
              .query<{ hash: string }, [string]>(
                "SELECT hash FROM sources WHERE id=?",
              )
              .get(indexedId)!.hash,
          }),
          indexedId,
          Date.now(),
        );
    rememberCapture(sdk, prepared, indexedId);
    if (prepared.jobId)
      finishJob(sdk, prepared.jobId, { sourceId, versionSourceId: indexedId });
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
