import { failSession } from "./session-failure";
import { acquireTaskLease } from "../../lib/task-lease";
import { finalizeBrowserPayload } from "./payload-pipeline";
import { finishJob, failJob, pendingJobs } from "./inbox-store";
import type { CheckpointContext, ShaleSDK } from "@shale/sdk";
import { finalizePageVisit } from "./ingest-processor";
import { finalizeSession } from "./session-manager";
import type { BrowserExtensionSettings } from "./settings.types";
import type { PreparedPageData } from "./types";

export interface RecoverResult {
  recoveredPages: number;
  recoveredSessions: number;
}

/**
 * Crash recovery runner invoked when queued checkpoints exist.
 * Embeds uncommitted summaries and commits sources, chunks, and graph edges without re-querying LLM.
 */
async function recoverOwned(
  sdk: ShaleSDK,
  context: CheckpointContext | undefined,
  assertOwned: () => void,
): Promise<RecoverResult> {
  const ctx = context ?? sdk.getCheckpointContext();
  if (ctx.count === 0) {
    return { recoveredPages: 0, recoveredSessions: 0 };
  }

  sdk.logger.info(
    `[Recovery] Found ${ctx.count} queued checkpoint(s). Beginning recovery...`,
  );

  let recoveredPages = 0;
  let recoveredSessions = 0;
  let failed = 0;

  for (const item of ctx.checkpoints) {
    if (!sdk.checkpoint.get(item.id)) continue;
    const data = item.data as any;
    if (!data || typeof data !== "object") {
      ctx.resolve(item.id);
      continue;
    }

    try {
      assertOwned();
      if (data.type === "browser_job") {
        await finalizeBrowserPayload(
          sdk,
          data.prepared,
          data.settings ?? sdk.settings.getAll<BrowserExtensionSettings>(),
          assertOwned,
          () => finishJob(sdk, data.jobId),
        );
        sdk.database.transaction(() => finishJob(sdk, data.jobId))();
        recoveredPages++;
      } else if (data.type === "browser_page_analysis") {
        const {
          pageData,
          analysis,
          namespace = sdk.namespace || "browser",
        } = data;
        if (!pageData || !analysis) {
          throw new Error("Malformed browser page checkpoint");
        }

        // Finalization is deliberately LLM-free. Reusing the normal Phase 2
        // path preserves HTML-derived chunks, links, images, and session edges.
        const prepared: PreparedPageData = {
          jobId: data.jobId,
          contentKey: data.contentKey,
          settings: data.settings,
          pageData,
          analysis,
          cleanUrl: pageData.cleanUrl || pageData.url,
          domain: pageData.domain || "",
          checkpointId: item.id,
          namespace,
          parser: data.parser,
          parsedChunks: data.parsedChunks,
          contextualSummary: data.contextualSummary,
          imageChunks: data.imageChunks,
          sessionUpdate: data.sessionUpdate,
        };
        await finalizePageVisit(
          sdk,
          prepared,
          data.settings ?? sdk.settings.getAll<BrowserExtensionSettings>(),
          assertOwned,
        );
        recoveredPages++;
      } else if (data.type === "browser_session_analysis") {
        const {
          sessionId,
          startTime,
          endTime,
          visits,
          synthesis,
          namespace = sdk.namespace || "browser",
        } = data;

        await finalizeSession(
          sdk,
          {
            ...data,
            sessionId,
            startTime,
            endTime,
            visits,
            synthesis,
            checkpointId: item.id,
            namespace,
          },
          data.settings ?? sdk.settings.getAll<BrowserExtensionSettings>(),
          assertOwned,
        );

        recoveredSessions++;
      }

      ctx.resolve(item.id);
    } catch (err: any) {
      if (!sdk.checkpoint.get(item.id)) continue;
      failed++;
      if (
        (data.type === "browser_job" ||
          data.type === "browser_page_analysis") &&
        data.jobId
      ) {
        const job = sdk.database
          .query<{ id: string; attempts: number }, [string, string]>(
            "SELECT id,attempts FROM browser_jobs WHERE extension_id=? AND id=? AND state IN ('received','prepared')",
          )
          .get(sdk.extensionId, data.jobId);
        if (job) failJob(sdk, job, err, data.settings?.maxJobAttempts ?? 5);
      }
      if (data.type === "browser_session_analysis" && data.collectorId)
        failSession(
          sdk,
          { ...data, checkpointId: item.id },
          err,
          data.settings?.maxJobAttempts ?? 5,
        );
      sdk.logger.error(
        `[Recovery] Failed recovering checkpoint ${item.id}: ${err?.message || err}`,
      );
    }
  }

  sdk.logger.info(
    `[Recovery] Finished. Recovered ${recoveredPages} page(s) and ${recoveredSessions} session(s).`,
  );

  // The host only removes all remaining checkpoint rows when this function
  // resolves successfully. Surface partial failures so failed work stays
  // queued for the next startup/cron retry.
  if (failed > 0) {
    throw new Error(`Browser checkpoint recovery failed for ${failed} item(s)`);
  }

  return { recoveredPages, recoveredSessions };
}

export async function run(
  sdk: ShaleSDK,
  context?: CheckpointContext,
): Promise<RecoverResult> {
  const lease = acquireTaskLease(
    sdk.database,
    sdk.extensionId,
    "browser-worker-lease",
    120000,
  );
  if (!lease) throw new Error("Browser worker already owns recovery");
  let lost: unknown;
  const renewal = setInterval(() => {
    try {
      lease.renew();
    } catch (error) {
      lost = error;
    }
  }, 30000);
  const assertOwned = () => {
    if (lost) throw lost;
    lease.renew();
  };
  try {
    return await recoverOwned(sdk, context, assertOwned);
  } finally {
    clearInterval(renewal);
    lease.release();
  }
}
export default run;
