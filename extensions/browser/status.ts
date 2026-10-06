import type { ShaleSDK } from "@shale/sdk";
import { pendingJobs } from "./inbox-store";
export function browserStatus(sdk: ShaleSDK, ids?: string[]) {
  pendingJobs(sdk, 0);
  const counts = Object.fromEntries(
    sdk.database
      .query<{ state: string; count: number }, [string]>(
        "SELECT state,count(*) AS count FROM browser_jobs WHERE extension_id=? GROUP BY state",
      )
      .all(sdk.extensionId)
      .map((row) => [row.state, row.count]),
  );
  const age = sdk.database
    .query<{ oldest: number | null }, [string]>(
      `SELECT min(received_at) AS oldest FROM browser_jobs WHERE extension_id=? AND state IN ('received','prepared')`,
    )
    .get(sdk.extensionId);
  const records = sdk.database
    .query<any, (string | number)[]>(
      `SELECT id AS jobId,collector_id AS collectorId,record_id AS recordId,state AS status,
    received_at AS receivedAt,updated_at AS updatedAt,attempts,error AS reason,outcome FROM browser_jobs WHERE extension_id=?
    ${ids?.length ? `AND id IN (${ids.map(() => "?").join(",")})` : ""} ORDER BY updated_at DESC LIMIT 100`,
    )
    .all(sdk.extensionId, ...(ids ?? []));
  const sessions = sdk.database
    .query<any, [string]>(
      `SELECT session_id AS sessionId,indexed_hash IS NOT NULL AS indexed,attempts,error AS reason,next_attempt_at AS nextAttemptAt
    FROM browser_sessions WHERE extension_id=? ORDER BY end_time DESC LIMIT 100`,
    )
    .all(sdk.extensionId);
  return {
    protocolVersion: 1,
    counts,
    sessions,
    oldestPendingAgeMs: age?.oldest ? Date.now() - age.oldest : 0,
    records: records.map((row) => ({
      ...row,
      outcome: row.outcome ? JSON.parse(row.outcome) : null,
    })),
  };
}
export function retryBrowserJobs(sdk: ShaleSDK, ids: string[]) {
  sdk.database.transaction(() => {
    for (const id of ids) {
      if (id.startsWith("browser_session:")) {
        sdk.database
          .query(
            "UPDATE browser_sessions SET attempts=0,next_attempt_at=0,error=NULL WHERE extension_id=? AND session_id=?",
          )
          .run(sdk.extensionId, id.slice("browser_session:".length));
      }
      sdk.database
        .query(
          `UPDATE browser_jobs SET state=CASE WHEN prepared IS NULL THEN 'received' ELSE 'prepared' END,
    attempts=0,next_attempt_at=0,error=NULL,updated_at=? WHERE extension_id=? AND id=? AND state='failed'`,
        )
        .run(Date.now(), sdk.extensionId, id);
      sdk.database
        .query(
          "UPDATE checkpoints SET status='queued' WHERE extension_id=? AND id=?",
        )
        .run(sdk.extensionId, id);
    }
  })();
}
