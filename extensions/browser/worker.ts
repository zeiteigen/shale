import { failSession } from "./session-failure";
import type { ShaleSDK } from "@shale/sdk";
import { acquireTaskLease } from "../../lib/task-lease";
import { browserSettings } from "./settings-policy";
import {
  pendingJobs,
  prepareJob,
  finishJob,
  failJob,
  type BrowserJob,
} from "./inbox-store";
import {
  prepareBrowserPayload,
  finalizeBrowserPayload,
  type PreparedBrowserPayload,
} from "./payload-pipeline";
import type { BrowserExtensionSettings } from "./settings.types";
import { prepareSessionJobs, finalizeSessionJob } from "./session-jobs";

/** One bounded chat-then-embedding batch, with durable output and transactional completion. */
export async function runWorker(sdk: ShaleSDK) {
  const policy = browserSettings(sdk);

  const lease = acquireTaskLease(
    sdk.database,
    sdk.extensionId,
    "browser-worker-lease",
    120000,
  );
  if (!lease)
    return {
      finalizedSessionTitle: null,
      pageCount: 0,
      processedPayloads: 0,
      queuedPayloads: 0,
      busy: true,
    };
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
    return await sdk.models.batch(
      async () => {
        assertOwned();
        const jobs = pendingJobs(sdk, policy.maxJobsPerRun);
        type PreparedJob = {
          job: BrowserJob;
          payload: PreparedBrowserPayload;
          settings: Partial<BrowserExtensionSettings>;
        };
        const selected: BrowserJob[] = [];
        let budget = 0,
          publicPages = 0;
        for (const job of jobs) {
          if (job.payload.type === "public_page_capture") {
            if (publicPages >= (policy.maxPublicPagesPerRun ?? 2)) continue;
            publicPages++;
          }
          const bytes = new TextEncoder().encode(
            JSON.stringify(job.payload),
          ).length;
          if (
            selected.length &&
            budget + bytes >
              (sdk.settings.get<number>("maxBatchBytes") ?? 1000000)
          )
            break;
          budget += bytes;
          selected.push(job);
        }
        const prepared = (await sdk.models.mapChat(selected, async (job): Promise<PreparedJob | null> => {
          assertOwned();
          const checkpoint = sdk.checkpoint.get<any>(job.id);
          const settings =
            job.settings ?? checkpoint?.data.settings ?? browserSettings(sdk);
          try {
            const payload =
              job.prepared ??
              (checkpoint?.data.type === "browser_job"
                ? checkpoint.data.prepared
                : checkpoint?.data.type === "browser_page_analysis"
                  ? {
                      type: "pages",
                      pages: [
                        {
                          ...checkpoint.data,
                          cleanUrl: checkpoint.data.pageData.cleanUrl,
                          domain: checkpoint.data.pageData.domain,
                          checkpointId: job.id,
                        },
                      ],
                    }
                  : await prepareBrowserPayload(sdk, job.payload, settings, {
                      jobId: job.id,
                      managed: true,
                    }));
            assertOwned();
            prepareJob(sdk, job, payload, settings);
            return { job, payload, settings };
          } catch (error) {
            failJob(sdk, job, error, settings.maxJobAttempts ?? 5);
            sdk.logger.error("Browser preparation retained for retry:", error);
            return null;
          }
        })).filter((item): item is PreparedJob => item !== null);
        // Context reads prepared page analyses from the cache; it never runs during embeddings.
        const settings = browserSettings(sdk);
        let sessions: Awaited<ReturnType<typeof prepareSessionJobs>> = [];
        try {
          sessions = await prepareSessionJobs(sdk, settings);
        } catch (error) {
          sdk.logger.error("Session preparation retained for retry:", error);
        }
        assertOwned();
        return { prepared, sessions, settings };
      },
      async ({ prepared, sessions, settings }) => {
        let processedPayloads = 0;
        let finalizedSessionTitle: string | null = null,
          pageCount = 0;
        for (const item of prepared) {
          assertOwned();
          try {
            await finalizeBrowserPayload(
              sdk,
              item.payload,
              item.settings,
              () => assertOwned(),
              () => finishJob(sdk, item.job.id),
            );
            assertOwned();
            sdk.database.transaction(() => finishJob(sdk, item.job.id))();
            processedPayloads++;
          } catch (error) {
            failJob(sdk, item.job, error, item.settings.maxJobAttempts ?? 5);
            sdk.logger.error("Browser commit retained for retry:", error);
          }
        }
        for (const session of sessions) {
          assertOwned();
          try {
            const result = await finalizeSessionJob(
              sdk,
              session,
              session.settings ?? settings,
              assertOwned,
            );
            finalizedSessionTitle = result.title;
            pageCount += result.pageCount;
          } catch (error) {
            failSession(sdk, session, error, settings.maxJobAttempts ?? 5);
            sdk.logger.error("Session commit retained for recovery:", error);
          }
        }
        return {
          finalizedSessionTitle,
          pageCount,
          processedPayloads,
          queuedPayloads: sdk.database
            .query<{ count: number }, [string]>(
              "SELECT count(*) AS count FROM browser_jobs WHERE extension_id=? AND state IN ('received','prepared')",
            )
            .get(sdk.extensionId)!.count,
        };
      },
    );
  } finally {
    clearInterval(renewal);
    lease.release();
  }
}
