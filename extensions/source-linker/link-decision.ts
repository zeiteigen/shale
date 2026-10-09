import type { ShaleSDK, EvidenceInput } from "@shale/sdk";
import type { DiscoveredLink, LLMLinkAnalysis } from "./types";

export interface LinkCheckpoint {
  evidenceA?: EvidenceInput[];
  evidenceB?: EvidenceInput[];
  extractionRun?: string;
  model?: string;
  sourceA: { id: string; title: string };
  sourceB: { id: string; title: string };
  analysis: LLMLinkAnalysis;
  accepted?: boolean;
  textScore: number;
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
    textScore: data.textScore,
    entityResolutions: data.analysis.entityResolutions ?? [],
    evidenceA:data.evidenceA,evidenceB:data.evidenceB,extractionRun:data.extractionRun,model:data.model,
  };
}
