import { getSDK, logger, type ShaleSDK } from "@shale/sdk";
import {
  processSourceLinks,
  commitLinksToGraph,
  WATERMARK_KEY,
} from "./process-links";
import { findCandidatePairs } from "./candidate-finder";
import { analyzeSourcePairWithLLM } from "./llm-analyzer";
import { run as recover, type RecoverResult } from "./recover";
import type {
  ProcessLinksResult,
  RunOptions,
  DiscoveredLink,
  SourceCandidatePair,
  LLMLinkAnalysis,
  EntityResolution,
} from "./types";

export {
  processSourceLinks,
  commitLinksToGraph,
  findCandidatePairs,
  analyzeSourcePairWithLLM,
  recover,
  WATERMARK_KEY,
  type ProcessLinksResult,
  type RecoverResult,
  type RunOptions,
  type DiscoveredLink,
  type SourceCandidatePair,
  type LLMLinkAnalysis,
  type EntityResolution,
};

/**
 * Main extension runner invoked by cron or CLI.
 * Prepares relationship analyses with checkpoints, then commits graph edges.
 *
 * @param sdkOverride Optional scoped SDK instance (ambient SDK discovered if omitted)
 * @param options Run options
 */
export async function run(
  sdkOverride?: ShaleSDK,
  options?: RunOptions,
): Promise<ProcessLinksResult> {
  const sdk = sdkOverride ?? getSDK();
  // Superseded by identity resolution and episodes; kept for explicit runs over older data.
  if (sdk.settings.get<boolean>("enabled") === false) {
    sdk.logger.log("Source linker is disabled; cross-source links come from knowledge-graph identity resolution and episodes.");
    const watermark = Number(sdk.state.getWatermark(WATERMARK_KEY) ?? 0);
    return { sourcesAnalyzed: 0, candidatePairsEvaluated: 0, linksCreated: 0, edgesCommitted: 0,
      watermarkAdvancedTo: Number.isFinite(watermark) ? watermark : 0, checkpointsResolved: 0 };
  }
  return processSourceLinks(sdk, options);
}

// Standalone execution support
if (import.meta.main) {
  run().catch((err) => {
    logger.error("Fatal error running source-linker:", err);
  });
}

export default run;
