import type { ShaleSDK } from "@shale/sdk";
import type { PreparedSessionData } from "./types";
/** Prepared session output is retained; exhausted failures require an explicit retry. */
export function failSession(
  sdk: ShaleSDK,
  prepared: PreparedSessionData,
  error: unknown,
  maxAttempts: number,
) {
  sdk.database.transaction(() => {
    const old = sdk.database
      .query<{ attempts: number }, [string, string]>(
        "SELECT attempts FROM browser_sessions WHERE extension_id=? AND session_id=?",
      )
      .get(sdk.extensionId, prepared.sessionId);
    const attempts = (old?.attempts ?? 0) + 1;
    sdk.database
      .query(
        `INSERT INTO browser_sessions(extension_id,session_id,collector_id,activity_hash,start_time,end_time,boundary_reason,attempts,next_attempt_at,error,prepared_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(extension_id,session_id) DO UPDATE SET attempts=excluded.attempts,next_attempt_at=excluded.next_attempt_at,error=excluded.error,prepared_at=coalesce(browser_sessions.prepared_at,excluded.prepared_at)`,
      )
      .run(
        sdk.extensionId,
        prepared.sessionId,
        prepared.collectorId ?? "legacy",
        prepared.activityHash ?? "",
        prepared.startTime,
        prepared.endTime,
        prepared.boundaryReason ?? "inactivity",
        attempts,
        Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(12, attempts)),
        String(error).slice(0, 2000),
        Date.now(),
      );
    if (attempts >= maxAttempts)
      sdk.database
        .query(
          "UPDATE checkpoints SET status='failed' WHERE extension_id=? AND id=?",
        )
        .run(sdk.extensionId, prepared.checkpointId);
  })();
}
