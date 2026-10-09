import type { ShaleSDK } from "@shale/sdk";
import type { PreparedPageData } from "./types";
import { browserSourceId } from "./identity";
export function contentVersion(prepared: PreparedPageData) {
  if (!prepared.jobId || !prepared.contentKey) return null;
  const publicPage = prepared.pageData.captureOrigin === "public-fetch";
  return {
    id: browserSourceId(
      "web-version",
      `${publicPage ? "public" : "dom"}:${prepared.cleanUrl}:${prepared.contentKey}`,
    ),
    uri: `browser-content-version://${encodeURIComponent(prepared.cleanUrl)}/${prepared.contentKey}`,
    type: publicPage ? "public_web_page_version" : "web_page_version",
  };
}
/** Restore an indexed version from its existing text chunks. */
export function copyIndexedContent(
  sdk: ShaleSDK,
  from: string,
  target: { id: string; uri: string; type: string },
  prepared: PreparedPageData,
) {
  const rows = sdk.database
    .query<
      {
        chunk_index: number;
        chunk_type: "verbatim" | "synthetic";
        text_content: string;
      },
      [string]
    >(
      `SELECT c.chunk_index,c.chunk_type,c.text_content FROM chunks c
      WHERE c.source_id=? ORDER BY c.chunk_index`,
    )
    .all(from);
  if (!rows.length)
    throw new Error("Cached page version has no indexed chunks");
  const hash = sdk.database
    .query<{ hash: string }, [string]>("SELECT hash FROM sources WHERE id=?")
    .get(from)!.hash;
  return sdk.ingest.sourceAndChunks({
    namespace: prepared.namespace,
    source: {
      ...target,
      hash,
      origin: "browser",
      title: prepared.pageData.title,
      created_at: prepared.pageData.capturedAt ?? prepared.pageData.visitedAt,
      updated_at: prepared.pageData.capturedAt ?? prepared.pageData.visitedAt,
    },
    chunks: rows,
  });
}
