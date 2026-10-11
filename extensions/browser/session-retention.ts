import type { ShaleSDK } from "@shale/sdk";
import { ensureBrowserSchema } from './storage-schema';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const EXPIRED_ATTEMPTS = 1_000_000;

/** Replaces expired prepared session bodies with a retryable status receipt. */
export function expirePreparedSessions(sdk: ShaleSDK, now = Date.now()): number {
  ensureBrowserSchema(sdk.database);
  const cutoff = now - RETENTION_MS;
  const rows = sdk.database.query<{ session_id: string }, [string, number, number, number]>(
    `SELECT session_id FROM browser_sessions WHERE extension_id=? AND (
      (prepared_at IS NOT NULL AND prepared_at<?) OR
      (prepared_at IS NULL AND prepared IS NOT NULL AND end_time<?) OR EXISTS (
        SELECT 1 FROM checkpoints c WHERE c.extension_id=browser_sessions.extension_id
          AND c.id='browser_session:'||browser_sessions.session_id AND c.created_at<?
      )
    ) AND (prepared IS NOT NULL OR settings IS NOT NULL OR EXISTS (
      SELECT 1 FROM checkpoints c WHERE c.extension_id=browser_sessions.extension_id
        AND c.id='browser_session:'||browser_sessions.session_id
    ))`,
  ).all(sdk.extensionId, cutoff, cutoff, cutoff);
  if (!rows.length) return 0;
  sdk.database.transaction(() => {
    for (const row of rows) {
      sdk.database.query(
        `UPDATE browser_sessions SET prepared=NULL,settings=NULL,prepared_at=NULL,
          attempts=max(attempts,?),next_attempt_at=0,
          error='Prepared session expired after 24 hours; recapture to retry'
         WHERE extension_id=? AND session_id=?`,
      ).run(EXPIRED_ATTEMPTS, sdk.extensionId, row.session_id);
      sdk.checkpoint.delete(`browser_session:${row.session_id}`);
    }
  })();
  return rows.length;
}
