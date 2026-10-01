import { getSDK, logger, type ShaleSDK } from "@shale/sdk";
import type { BrowserExtensionSettings } from "./settings.types";
import {
  finalizeSession,
  getActiveSession,
  prepareSession,
  setActiveSession,
} from "./session-manager";
import { run as runRecover } from "./recover";
import {
  acknowledgeQueuedBrowserPayloads,
  getQueuedBrowserPayloads,
} from "./ingest-queue";
import {
  prepareBrowserPayload,
  finalizeBrowserPayload,
  type PreparedBrowserPayload,
} from "./payload-pipeline";
import type { PageVisitPayload } from "./types";
import { normalizeUrl } from "./filter";

export interface SessionAggregatorResult {
  finalizedSessionTitle: string | null;
  pageCount: number;
  processedPayloads?: number;
  queuedPayloads?: number;
}

/**
 * Main cron entrypoint for the browser extension.
 * Periodically reviews active sessions, checks inactivity boundaries,
 * and synthesizes idle sessions into cohesive knowledge graph entities.
 */
export async function run(
  sdkOverride?: ShaleSDK,
): Promise<SessionAggregatorResult> {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const settings = sdk.settings.getAll<BrowserExtensionSettings>();

  sdk.logger.info("Running browser session aggregator cron...");

  const queued = getQueuedBrowserPayloads(sdk);
  return sdk.models.batch(
    async () => {
      const prepared: Array<{
        ids: string[];
        count: number;
        payload: PreparedBrowserPayload;
      }> = [];
      const pageByUrl = new Map<string, PageVisitPayload>();
      const pageIds: string[] = [];
      const others: typeof queued = [];
      for (const item of queued) {
        if (
          item.payload.type === "page_visit" ||
          item.payload.type === "active_page"
        ) {
          const normalized = normalizeUrl(item.payload.url);
          const key = normalized.isValid
            ? normalized.cleanUrl
            : item.payload.url;
          const previous = pageByUrl.get(key);
          if (
            !previous ||
            (item.payload.visitedAt ?? 0) >= (previous.visitedAt ?? 0)
          )
            pageByUrl.set(key, item.payload);
          pageIds.push(item.id);
        } else others.push(item);
      }
      const pages = [...pageByUrl.values()].sort(
        (a, b) => (a.visitedAt ?? 0) - (b.visitedAt ?? 0),
      );
      const jobs = [
        ...(pages.length
          ? [
              {
                ids: pageIds,
                count: pages.length,
                payload: { type: "tabs_batch" as const, pages },
              },
            ]
          : []),
        ...others.map((item) => ({
          ids: [item.id],
          count: 1,
          payload: item.payload,
        })),
      ];
      for (const job of jobs) {
        try {
          prepared.push({
            ...job,
            payload: await prepareBrowserPayload(sdk, job.payload, settings),
          });
        } catch (error) {
          sdk.logger.error(
            "Browser preparation failed; retaining inbox items:",
            error,
          );
        }
      }
      const active = getActiveSession(sdk);
      const inactivityMs = (settings.sessionInactivityMinutes ?? 30) * 60_000;
      const session =
        active?.visits.length &&
        Date.now() - active.lastActivityTime > inactivityMs
          ? await prepareSession(
              sdk,
              active.sessionId,
              active.startTime,
              active.lastActivityTime,
              active.visits,
              settings,
            )
          : null;
      return { prepared, session };
    },
    async ({ prepared, session }) => {
      let processedPayloads = 0;
      const acknowledged = new Set<string>();
      for (const job of prepared) {
        try {
          await finalizeBrowserPayload(sdk, job.payload, settings);
          processedPayloads += job.count;
          for (const id of job.ids) acknowledged.add(id);
        } catch (error) {
          sdk.logger.error(
            "Browser embedding/commit failed; retaining inbox items:",
            error,
          );
        }
      }
      acknowledgeQueuedBrowserPayloads(sdk, acknowledged);
      const result = session
        ? await finalizeSession(sdk, session, settings)
        : null;
      if (result && getActiveSession(sdk)?.sessionId === session?.sessionId)
        setActiveSession(sdk, null);
      return {
        finalizedSessionTitle: result?.title ?? null,
        pageCount: result?.pageCount ?? 0,
        processedPayloads,
        queuedPayloads: queued.length,
      };
    },
  );
}

// Standalone execution support
if (import.meta.main) {
  run().catch((err) => {
    logger.error("Fatal error running browser session aggregator:", err);
  });
}

export { runRecover };
export default run;
