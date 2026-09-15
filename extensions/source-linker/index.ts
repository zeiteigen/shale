import { getSDK, logger, type ShaleSDK } from "@shale/sdk";
import {
  processSourceLinks,
  commitLinksToGraph,
  WATERMARK_KEY,
} from "./process-links";
import { findKnnCandidatePairs } from "./knn-finder";
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
  findKnnCandidatePairs,
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
 * Enforces the two-phase pipeline:
 * Phase 1: Chat model analysis & checkpointing.
 * Phase 2: Ingestion & knowledge graph edge commits.
 *
 * @param sdkOverride Optional scoped SDK instance (ambient SDK discovered if omitted)
 * @param options Run options
 */
export async function run(
  sdkOverride?: ShaleSDK,
  options?: RunOptions,
): Promise<ProcessLinksResult> {
  const sdk = sdkOverride ?? getSDK();
  return processSourceLinks(sdk, options);
}

// Standalone execution support
if (import.meta.main) {
  run().catch((err) => {
    logger.error("Fatal error running source-linker:", err);
  });
}

export default run;
