import type { ShaleSDK } from "@shale/sdk";
import type { DiscoveredLink, LLMLinkAnalysis } from "./types";

export interface LinkCheckpoint {
  sourceA: { id: string; title: string };
  sourceB: { id: string; title: string };
  analysis: LLMLinkAnalysis;
  accepted?: boolean;
  knnSimilarity: number;
  updatedAt: number;
}

/** Preserve the original decision across retries; validate older checkpoints consistently. */
export function acceptedLink(data: LinkCheckpoint, sdk: ShaleSDK): DiscoveredLink | null {
  const minimum = sdk.settings.get<number>("minLlmConfidence") ?? 0.5;
  const accepted = data.accepted ??
    (data.analysis.shouldLink && data.analysis.weight >= minimum);
  if (!accepted) return null;
  return {
    sourceIdA: data.sourceA.id,
    sourceTitleA: data.sourceA.title,
    sourceIdB: data.sourceB.id,
    sourceTitleB: data.sourceB.title,
    relation: data.analysis.relation,
    reason: data.analysis.reason,
    weight: data.analysis.weight,
    knnSimilarity: data.knnSimilarity,
    entityResolutions: data.analysis.entityResolutions ?? [],
  };
}
