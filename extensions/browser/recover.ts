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
export async function run(
  sdk: ShaleSDK,
  context?: CheckpointContext,
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
    const data = item.data as any;
    if (!data || typeof data !== "object") {
      ctx.resolve(item.id);
      continue;
    }

    try {
      if (data.type === "browser_page_analysis") {
        const { pageData, analysis, namespace = sdk.namespace || "browser" } = data;
        if (!pageData || !analysis) {
          throw new Error("Malformed browser page checkpoint");
        }

        // Finalization is deliberately LLM-free. Reusing the normal Phase 2
        // path preserves HTML-derived chunks, links, images, and session edges.
        const prepared: PreparedPageData = {
          pageData,
          analysis,
          cleanUrl: pageData.cleanUrl || pageData.url,
          domain: pageData.domain || "",
          checkpointId: item.id,
          namespace,
          parsedChunks: data.parsedChunks,
          contextualSummary: data.contextualSummary,
          imageChunks: data.imageChunks,
        };
        await finalizePageVisit(
          sdk,
          prepared,
          sdk.settings.getAll<BrowserExtensionSettings>(),
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

        await finalizeSession(sdk, {
          sessionId,
          startTime,
          endTime,
          visits,
          synthesis,
          checkpointId: item.id,
          namespace,
        }, sdk.settings.getAll<BrowserExtensionSettings>());

        recoveredSessions++;
      }

      ctx.resolve(item.id);
    } catch (err: any) {
      failed++;
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

export default run;
