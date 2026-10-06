import type { ShaleSDK } from "@shale/sdk";
import type {
  BrowserQuery,
  BrowserQueryResult,
} from "../../lib/messages/browser-contracts";
import { ensureBrowserSchema } from "./storage-schema";

/** Filter browsing context first, then rank captured evidence above catalog metadata. */
export function queryBrowser(
  sdk: ShaleSDK,
  filter: BrowserQuery = {},
): BrowserQueryResult {
  ensureBrowserSchema(sdk.database);
  const limit = Math.max(1, Math.min(100, filter.limit ?? 20));
  for (const value of [limit, filter.from, filter.to])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error("Invalid browser query bounds");
  const words =
    (filter.query || "").match(/[\p{L}\p{N}_]+/gu)?.slice(0, 20) ?? [];
  const match = words.map((word) => `"${word}"`).join(" OR ");
  const contextConditions: string[] = [
    "a.extension_id=?",
    "json_extract(a.payload,'$.url')=coalesce(json_extract(cache.prepared,'$.pageData.cleanUrl'),s.uri)",
  ];
  const contextParams: any[] = [sdk.extensionId];
  if (filter.collectorId) {
    contextConditions.push("a.collector_id=?");
    contextParams.push(filter.collectorId);
  }
  if (filter.from !== undefined) {
    contextConditions.push("a.occurred_at>=?");
    contextParams.push(filter.from);
  }
  if (filter.to !== undefined) {
    contextConditions.push("a.occurred_at<=?");
    contextParams.push(filter.to);
  }
  if (filter.sessionId) {
    contextConditions.push("m.session_id=?");
    contextParams.push(filter.sessionId);
  }
  if (filter.threadId) {
    contextConditions.push("m.thread_id=?");
    contextParams.push(filter.threadId);
  }
  if (filter.topic) {
    contextConditions.push(
      "EXISTS(SELECT 1 FROM json_each(t.topics) WHERE lower(value)=lower(?))",
    );
    contextParams.push(filter.topic);
  }
  if (filter.goal) {
    contextConditions.push("lower(coalesce(t.goal,'')) LIKE ?");
    contextParams.push(`%${filter.goal.toLowerCase()}%`);
  }
  const contextual =
    filter.collectorId ||
    filter.from !== undefined ||
    filter.to !== undefined ||
    filter.sessionId ||
    filter.threadId ||
    filter.topic ||
    filter.goal;
  const where: string[] = [
    "s.origin='browser'",
    contextual
      ? "s.type IN ('web_page_version','public_web_page_version')"
      : "s.type IN ('web_page','public_web_page')",
    "c.chunk_type='verbatim'",
  ];
  const params: any[] = [];
  if (match) {
    where.push("chunks_fts MATCH ?");
    params.push(match);
  }
  if (contextual) {
    contextConditions.push(
      "EXISTS(SELECT 1 FROM browser_captures bc WHERE bc.extension_id=a.extension_id AND bc.collector_id=a.collector_id AND bc.event_id=a.event_id AND bc.source_id=s.id)",
    );
    where.push(`EXISTS(SELECT 1 FROM browser_activity a LEFT JOIN browser_context_members m ON m.extension_id=a.extension_id AND m.collector_id=a.collector_id AND m.event_id=a.event_id
    LEFT JOIN browser_threads t ON t.extension_id=m.extension_id AND t.thread_id=m.thread_id WHERE ${contextConditions.join(" AND ")})`);
    params.push(...contextParams);
  }
  if (filter.domain) {
    const domain = filter.domain.toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(domain)) throw new Error("Invalid domain");
    const patterns = ["http", "https"].flatMap((scheme) => [
      `${scheme}://${domain}/%`,
      `${scheme}://${domain}:%/%`,
      `${scheme}://%.${domain}/%`,
      `${scheme}://%.${domain}:%/%`,
    ]);
    where.push(
      "(" +
        patterns
          .map(
            () =>
              "lower(coalesce(json_extract(cache.prepared,'$.pageData.cleanUrl'),s.uri)) LIKE ?",
          )
          .join(" OR ") +
        ")",
    );
    params.push(...patterns);
  }
  if (
    filter.quality &&
    !["full", "partial", "metadata"].includes(filter.quality)
  )
    throw new Error("Invalid capture quality");
  if (filter.quality) {
    where.push("json_extract(cache.prepared,'$.parser.extraction.quality')=?");
    params.push(filter.quality);
  }
  const pages = sdk.database
    .query<any, any[]>(
      `SELECT s.id AS sourceId,s.title,coalesce(json_extract(cache.prepared,'$.pageData.cleanUrl'),s.uri) AS url,c.text_content AS passage,c.chunk_index AS chunkIndex,
    coalesce(json_extract(cache.prepared,'$.parser.extraction.quality'),'metadata') AS quality,
    cache.prepared,${match ? "bm25(chunks_fts)" : "0"} AS rank FROM ${match ? "chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid" : "chunks c"}
    JOIN sources s ON s.id=c.source_id LEFT JOIN browser_content_cache cache ON (cache.source_id=s.id OR json_extract(cache.prepared,'$.canonicalSourceId')=s.id) AND cache.extension_id=?
      AND cache.content_key=(SELECT cc.content_key FROM browser_content_cache cc WHERE (cc.source_id=s.id OR json_extract(cc.prepared,'$.canonicalSourceId')=s.id) AND cc.extension_id=? AND json_extract(cc.prepared,'$.indexedHash')=s.hash ORDER BY cc.updated_at DESC,cc.content_key LIMIT 1)
    WHERE ${where.join(" AND ")} ORDER BY s.type='public_web_page',rank,s.updated_at DESC,c.chunk_index LIMIT ?`,
    )
    .all(sdk.extensionId, sdk.extensionId, ...params, limit)
    .map((row) => {
      const prepared = row.prepared ? JSON.parse(row.prepared) : null;
      const located = prepared?.parser?.chunkLocators?.[row.chunkIndex - 1];
      return {
        sourceId: row.sourceId,
        title: row.title,
        url: row.url,
        passage: row.passage,
        captureOrigin: prepared?.pageData?.captureOrigin ?? "unknown",
        quality: row.quality,
        rank: row.rank,
        locator: located?.locator ?? null,
        headingPath: located?.headingPath ?? [],
      };
    });
  const sessionWhere = ["b.extension_id=?", "b.end_time>=?", "b.start_time<=?"];
  const sessionParams: any[] = [
    sdk.extensionId,
    filter.from ?? 0,
    filter.to ?? Number.MAX_SAFE_INTEGER,
  ];
  if (filter.collectorId) {
    sessionWhere.push("b.collector_id=?");
    sessionParams.push(filter.collectorId);
  }
  if (filter.sessionId) {
    sessionWhere.push("b.session_id=?");
    sessionParams.push(filter.sessionId);
  }
  const threadWhere = ["t.extension_id=?"];
  const threadParams: any[] = [sdk.extensionId];
  if (filter.threadId) {
    threadWhere.push("t.thread_id=?");
    threadParams.push(filter.threadId);
  }
  if (filter.goal) {
    threadWhere.push("lower(coalesce(t.goal,'')) LIKE ?");
    threadParams.push(`%${filter.goal.toLowerCase()}%`);
  }
  if (filter.topic) {
    threadWhere.push(
      "EXISTS(SELECT 1 FROM json_each(t.topics) WHERE lower(value)=lower(?))",
    );
    threadParams.push(filter.topic);
  }
  if (filter.threadId || filter.goal || filter.topic) {
    sessionWhere.push(`EXISTS(SELECT 1 FROM browser_context_members cm JOIN browser_threads t ON t.extension_id=cm.extension_id AND t.thread_id=cm.thread_id
    WHERE cm.session_id=b.session_id AND cm.extension_id=b.extension_id AND ${threadWhere.join(" AND ")})`);
    sessionParams.push(...threadParams);
  }
  if (words.length) {
    sessionWhere.push(
      "(" +
        words
          .map(
            () =>
              "(lower(s.title) LIKE ? OR EXISTS(SELECT 1 FROM chunks sc WHERE sc.source_id=s.id AND lower(sc.text_content) LIKE ?))",
          )
          .join(" OR ") +
        ")",
    );
    for (const word of words)
      sessionParams.push(`%${word.toLowerCase()}%`, `%${word.toLowerCase()}%`);
  }
  const sessions = sdk.database
    .query<any, any[]>(
      `SELECT b.session_id AS sessionId,b.collector_id AS collectorId,
    b.start_time AS startTime,b.end_time AS endTime,s.title,(SELECT text_content FROM chunks WHERE source_id=s.id AND chunk_index=0) AS summary
    FROM browser_sessions b JOIN sources s ON s.id='session:'||b.session_id WHERE ${sessionWhere.join(" AND ")} ORDER BY b.end_time DESC LIMIT ?`,
    )
    .all(...sessionParams, limit);
  if (
    filter.collectorId ||
    filter.sessionId ||
    filter.from !== undefined ||
    filter.to !== undefined
  ) {
    threadWhere.push(`EXISTS(SELECT 1 FROM browser_context_members cm JOIN browser_sessions bs ON bs.extension_id=cm.extension_id AND bs.session_id=cm.session_id
    WHERE cm.extension_id=t.extension_id AND cm.thread_id=t.thread_id AND bs.end_time>=? AND bs.start_time<=?
      AND (? IS NULL OR cm.collector_id=?) AND (? IS NULL OR cm.session_id=?))`);
    threadParams.push(
      filter.from ?? 0,
      filter.to ?? Number.MAX_SAFE_INTEGER,
      filter.collectorId ?? null,
      filter.collectorId ?? null,
      filter.sessionId ?? null,
      filter.sessionId ?? null,
    );
  }
  if (words.length) {
    threadWhere.push(
      "(" +
        words
          .map(
            () =>
              "lower(t.label||' '||coalesce(t.goal,'')||' '||t.topics) LIKE ?",
          )
          .join(" OR ") +
        ")",
    );
    threadParams.push(...words.map((word) => `%${word.toLowerCase()}%`));
  }
  const threads = sdk.database
    .query<any, any[]>(
      `SELECT t.thread_id AS threadId,t.label,t.goal,t.topics FROM browser_threads t WHERE ${threadWhere.join(" AND ")}
    AND EXISTS(SELECT 1 FROM browser_context_members cm WHERE cm.extension_id=t.extension_id AND cm.thread_id=t.thread_id) ORDER BY t.updated_at DESC LIMIT ?`,
    )
    .all(...threadParams, limit)
    .map((row) => ({ ...row, topics: JSON.parse(row.topics) }));
  return { pages, sessions, threads };
}
export function correctContext(
  sdk: ShaleSDK,
  input: {
    collectorId: string;
    eventIds: string[];
    threadId?: string;
    label: string;
    goal?: string;
  },
) {
  if (
    typeof input.collectorId !== "string" ||
    !input.collectorId ||
    input.collectorId.length > 200 ||
    typeof input.label !== "string" ||
    !input.label.trim() ||
    input.label.length > 300 ||
    !Array.isArray(input.eventIds) ||
    !input.eventIds.length ||
    input.eventIds.length > 500 ||
    input.eventIds.some((id) => typeof id !== "string" || id.length > 200)
  )
    throw new Error("Invalid context correction");
  if (
    input.goal !== undefined &&
    (typeof input.goal !== "string" || input.goal.length > 300)
  )
    throw new Error("Invalid goal");
  const id = input.threadId || crypto.randomUUID();
  if (id.length > 200) throw new Error("Invalid thread ID");
  sdk.database.transaction(() => {
    for (const event of input.eventIds) {
      if (
        !sdk.database
          .query(
            "SELECT 1 FROM browser_activity WHERE extension_id=? AND collector_id=? AND event_id=?",
          )
          .get(sdk.extensionId, input.collectorId, event)
      )
        throw new Error("Unknown activity event");
      sdk.database
        .query(
          `INSERT INTO browser_context_overrides VALUES(?,?,?,?,?,?) ON CONFLICT(extension_id,collector_id,event_id)
        DO UPDATE SET thread_id=excluded.thread_id,label=excluded.label,goal=excluded.goal`,
        )
        .run(
          sdk.extensionId,
          input.collectorId,
          event,
          id,
          input.label,
          input.goal ?? null,
        );
    }
    sdk.database
      .query(
        "DELETE FROM checkpoints WHERE extension_id=? AND id IN (SELECT 'browser_session:'||session_id FROM browser_sessions WHERE extension_id=? AND collector_id=?)",
      )
      .run(sdk.extensionId, sdk.extensionId, input.collectorId);
    sdk.database
      .query(
        "UPDATE browser_sessions SET indexed_hash=NULL,prepared=NULL WHERE extension_id=? AND collector_id=?",
      )
      .run(sdk.extensionId, input.collectorId);
  })();
  return { threadId: id };
}
