import { failSession } from "./session-failure";
import type { ShaleSDK } from "@shale/sdk";
import type { BrowserExtensionSettings } from "./settings.types";
import type { PreparedSessionData } from "./types";
import { pendingSessions } from "./session-reducer";
import { prepareSession, finalizeSession } from "./session-ingest";
import { buildResearchThreads } from "./context-builder";
import { expirePreparedSessions } from "./session-retention";

export async function prepareSessionJobs(
  sdk: ShaleSDK,
  settings: Partial<BrowserExtensionSettings>,
) {
  expirePreparedSessions(sdk);
  const results: PreparedSessionData[] = [];
  for (const observed of pendingSessions(
    sdk,
    settings,
    settings.maxSessionsPerRun ?? 3,
  )) {
    const old = sdk.database
      .query<
        {
          prepared: string | null;
          activity_hash: string;
          settings: string | null;
        },
        [string, string]
      >(
        "SELECT prepared,activity_hash,settings FROM browser_sessions WHERE extension_id=? AND session_id=?",
      )
      .get(sdk.extensionId, observed.sessionId);
    if (old?.prepared && old.activity_hash === observed.activityHash) {
      results.push({ ...JSON.parse(old.prepared), settings });
      continue;
    }
    try {
      const checkpoint = sdk.checkpoint.get<any>(
        `browser_session:${observed.sessionId}`,
      );
      const previous = checkpoint?.data;
      const prepared: PreparedSessionData =
        previous?.activityHash === observed.activityHash && previous.synthesis
          ? { ...previous, settings, checkpointId: checkpoint!.id }
          : await prepareSession(
              sdk,
              observed.sessionId,
              observed.startTime,
              observed.endTime,
              observed.visits,
              settings,
              observed,
            );
      const analysisSettings = prepared.settings ?? settings;
      Object.assign(prepared, {
        activityHash: observed.activityHash,
        collectorId: observed.collectorId,
        boundaryReason: observed.boundaryReason,
        settings: analysisSettings,
      });
      prepared.threads = await buildResearchThreads(
        sdk,
        observed.visits,
        analysisSettings,
      );
      sdk.database.transaction(() => {
        const { settings: _settings, ...durablePrepared } = prepared;
        sdk.checkpoint.save(
          {
            type: "browser_session_analysis",
            ...durablePrepared,
          },
          { id: prepared.checkpointId, key: prepared.checkpointId },
        );
        sdk.database
          .query(
          `INSERT INTO browser_sessions(extension_id,session_id,collector_id,activity_hash,start_time,end_time,boundary_reason,prepared,settings,prepared_at)
        VALUES(?,?,?,?,?,?,?, ?,NULL,?) ON CONFLICT(extension_id,session_id) DO UPDATE SET activity_hash=excluded.activity_hash,
        start_time=excluded.start_time,end_time=excluded.end_time,boundary_reason=excluded.boundary_reason,prepared=excluded.prepared,settings=NULL,prepared_at=excluded.prepared_at,
        attempts=CASE WHEN activity_hash=excluded.activity_hash THEN attempts ELSE 0 END,
        next_attempt_at=CASE WHEN activity_hash=excluded.activity_hash THEN next_attempt_at ELSE 0 END,
        error=CASE WHEN activity_hash=excluded.activity_hash THEN error ELSE NULL END`,
          )
          .run(
            sdk.extensionId,
            observed.sessionId,
            observed.collectorId,
            observed.activityHash,
            observed.startTime,
            observed.endTime,
            observed.boundaryReason,
            JSON.stringify(durablePrepared),
            Date.now(),
          );
      })();
      results.push(prepared);
    } catch (error) {
      const checkpoint = sdk.checkpoint.get<any>(
        `browser_session:${observed.sessionId}`,
      );
      if (checkpoint)
        failSession(
          sdk,
          { ...checkpoint.data, checkpointId: checkpoint.id },
          error,
          settings.maxJobAttempts ?? 5,
        );
      sdk.logger.error("Session preparation retained for retry:", error);
    }
  }
  return results;
}
export async function finalizeSessionJob(
  sdk: ShaleSDK,
  prepared: PreparedSessionData,
  settings: Partial<BrowserExtensionSettings>,
  assertOwned: () => void = () => {},
) {
  return finalizeSession(sdk, prepared, settings, assertOwned);
}
