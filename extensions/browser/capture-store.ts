import type { ShaleSDK } from "@shale/sdk";
import type { PreparedPageData } from "./types";
/** Link each capture to its immutable content version and requesting activity. */
export function rememberCapture(
  sdk: ShaleSDK,
  prepared: PreparedPageData,
  sourceId: string,
) {
  if (!prepared.jobId || !prepared.contentKey) return;
  const page = prepared.pageData,
    collector = page.collectorId ?? "legacy",
    record = page.recordId ?? prepared.jobId;
  const previous = sdk.database
    .query<{ content_key: string }, [string, string, string]>(
      "SELECT content_key FROM browser_captures WHERE extension_id=? AND collector_id=? AND record_id=?",
    )
    .get(sdk.extensionId, collector, record);
  sdk.database
    .query(
      `INSERT INTO browser_captures VALUES(?,?,?,?,?,?,?) ON CONFLICT(extension_id,collector_id,record_id)
    DO UPDATE SET source_id=excluded.source_id`,
    )
    .run(
      sdk.extensionId,
      collector,
      record,
      page.eventId ?? record,
      prepared.contentKey,
      page.capturedAt ?? page.visitedAt,
      sourceId,
    );
  if (previous || !page.eventId) return;
  const sessions = sdk.database
    .query<{ session_id: string }, [string, string, string]>(
      `SELECT session_id FROM browser_context_members
    WHERE extension_id=? AND collector_id=? AND event_id=?`,
    )
    .all(sdk.extensionId, collector, page.eventId);
  for (const session of sessions) {
    sdk.database
      .query(
        `UPDATE browser_sessions SET indexed_hash=NULL,prepared=NULL,error=NULL,attempts=0,next_attempt_at=0
      WHERE extension_id=? AND session_id=?`,
      )
      .run(sdk.extensionId, session.session_id);
    sdk.checkpoint.delete(`browser_session:${session.session_id}`);
  }
}
