import type { ShaleSDK, CheckpointContext } from "@shale/sdk";
import { commitLinksToGraph, WATERMARK_KEY } from "./process-links";
import type { DiscoveredLink } from "./types";

export interface RecoverResult {
  recoveredCount: number;
  edgesCommitted: number;
  watermarkAdvancedTo: number;
}

/**
 * Crash recovery runner invoked by wait_for_checkpoint_script when uncommitted
 * link analysis checkpoints exist from a previous interrupted run.
 *
 * Commits cached LLM link decisions to the knowledge graph, cleans up checkpoints,
 * and advances the watermark.
 */
export async function run(
  sdk: ShaleSDK,
  contextOverride?: CheckpointContext,
): Promise<RecoverResult> {
  const context = contextOverride ?? sdk.getCheckpointContext<any>();
  sdk.logger.log(
    `[Recovery] Starting checkpoint recovery for source-linker (${context.count} queued checkpoints)...`,
  );

  if (context.count === 0) {
    return {
      recoveredCount: 0,
      edgesCommitted: 0,
      watermarkAdvancedTo: 0,
    };
  }

  const namespace =
    sdk.settings.get<string>("namespace") ?? "source-linker";
  const bidirectional =
    sdk.settings.get<boolean>("bidirectional") ?? true;

  const recoveredLinks: DiscoveredLink[] = [];
  let maxUpdatedAt = 0;

  for (const cp of context.checkpoints) {
    try {
      const data = cp.data;
      if (!data) continue;

      if (data.updatedAt && data.updatedAt > maxUpdatedAt) {
        maxUpdatedAt = data.updatedAt;
      }

      if (data.analysis && data.analysis.shouldLink) {
        recoveredLinks.push({
          sourceIdA: data.sourceA.id,
          sourceTitleA: data.sourceA.title,
          sourceIdB: data.sourceB.id,
          sourceTitleB: data.sourceB.title,
          relation: data.analysis.relation,
          reason: data.analysis.reason,
          weight: data.analysis.weight,
          knnSimilarity: data.knnSimilarity ?? 0.8,
          entityResolutions: data.analysis.entityResolutions ?? [],
        });
      }
    } catch (err: any) {
      sdk.logger.warn(`Failed to inspect checkpoint ${cp.id}:`, err?.message || err);
    }
  }

  // Commit recovered links to knowledge graph
  let edgesCommitted = 0;
  if (recoveredLinks.length > 0) {
    edgesCommitted = commitLinksToGraph(
      recoveredLinks,
      sdk,
      namespace,
      bidirectional,
    );
    sdk.logger.log(
      `[Recovery] Successfully committed ${edgesCommitted} edges for ${recoveredLinks.length} recovered links.`,
    );
  }

  // Resolve and delete all processed checkpoints
  for (const cp of context.checkpoints) {
    context.resolve(cp.id);
  }

  // Advance watermark
  if (maxUpdatedAt > 0) {
    const currentWatermark = Number(sdk.state.getWatermark(WATERMARK_KEY) ?? "0");
    if (maxUpdatedAt > currentWatermark) {
      sdk.state.setWatermark(String(maxUpdatedAt), WATERMARK_KEY);
      sdk.logger.log(`[Recovery] Watermark advanced to ${maxUpdatedAt}.`);
    }
  }

  sdk.logger.log(
    `[Recovery] Finished. Recovered ${recoveredLinks.length} link(s), deleted ${context.count} checkpoint(s).`,
  );

  return {
    recoveredCount: recoveredLinks.length,
    edgesCommitted,
    watermarkAdvancedTo: maxUpdatedAt,
  };
}

export default run;
