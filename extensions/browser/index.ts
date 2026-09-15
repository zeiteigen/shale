import { getSDK, logger, type ShaleSDK } from "@shale/sdk";
import type { BrowserExtensionSettings } from "./settings.types";
import { finalizeActiveSession, getActiveSession } from "./session-manager";
import { run as runRecover } from "./recover";
import {
  acknowledgeQueuedBrowserPayloads,
  getQueuedBrowserPayloads,
} from "./ingest-queue";
import { processBrowserPayload, processTabsBatch } from "./ingest-processor";
import type { PageVisitPayload } from "./types";

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

  // Drain the durable subscriber inbox here, rather than doing expensive work on
  // the HTTP ingest worker. Page visits are coalesced so all page LLM calls run
  // before their embedding pass.
  const queued = getQueuedBrowserPayloads(sdk);
  let processedPayloads = 0;
  if (queued.length > 0) {
    sdk.logger.info(
      `Parsing ${queued.length} queued browser payload(s) as one cron batch...`,
    );
    const processedIds = new Set<string>();
    const pages: PageVisitPayload[] = [];
    const pageIds = new Set<string>();
    const others: typeof queued = [];
    for (const item of queued) {
      if (
        item.payload.type === "page_visit" ||
        item.payload.type === "active_page"
      ) {
        pages.push(item.payload);
        pageIds.add(item.id);
      } else {
        others.push(item);
      }
    }
    try {
      if (pages.length) {
        await processTabsBatch(sdk, { type: "tabs_batch", pages }, settings);
        processedPayloads += pages.length;
        for (const id of pageIds) processedIds.add(id);
      }
      for (const item of others) {
        try {
          await processBrowserPayload(sdk, item.payload, settings);
          processedPayloads++;
          processedIds.add(item.id);
        } catch (error) {
          sdk.logger.error(
            `Keeping queued browser payload ${item.id} for retry:`,
            error,
          );
        }
      }
    } catch (error) {
      // A failed page batch has not been acknowledged; retain every page for retry.
      sdk.logger.error("Browser page batch failed; retaining it for retry:", error);
    }
    acknowledgeQueuedBrowserPayloads(sdk, processedIds);
  }

  const active = getActiveSession(sdk);
  if (!active || active.visits.length === 0) {
    sdk.logger.info("No active browsing session pending aggregation.");
    return {
      finalizedSessionTitle: null,
      pageCount: 0,
      processedPayloads,
      queuedPayloads: queued.length,
    };
  }

  const inactivityMs = (settings.sessionInactivityMinutes ?? 30) * 60 * 1000;
  const idleTimeMs = Date.now() - active.lastActivityTime;

  if (idleTimeMs > inactivityMs) {
    sdk.logger.info(
      `Active session ${active.sessionId} has been idle for ${Math.round(
        idleTimeMs / 60000,
      )} minutes (threshold: ${settings.sessionInactivityMinutes}m). Finalizing session...`,
    );

    const result = await finalizeActiveSession(sdk, settings);
    if (result) {
      sdk.logger.info(
        `Successfully synthesized session "${result.title}" (${result.pageCount} pages, ${result.edgesCount} edges).`,
      );
      return {
        finalizedSessionTitle: result.title,
        pageCount: result.pageCount,
        processedPayloads,
        queuedPayloads: queued.length,
      };
    }
  } else {
    sdk.logger.info(
      `Active session ${active.sessionId} is still active (${active.visits.length} pages, idle for ${Math.round(
        idleTimeMs / 60000,
      )}m).`,
    );
  }

  return {
    finalizedSessionTitle: null,
    pageCount: active.visits.length,
    processedPayloads,
    queuedPayloads: queued.length,
  };
}

// Standalone execution support
if (import.meta.main) {
  run().catch((err) => {
    logger.error("Fatal error running browser session aggregator:", err);
  });
}

export { runRecover };
export default run;
