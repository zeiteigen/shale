import type { ShaleSDK } from "@shale/sdk";
import type { SourceCandidatePair } from "./types";

export const WATERMARK_KEY = "last_source_update";
export const BATCH_ID = "source_link_batch";
export interface LinkBatch {
  type: "link_batch";
  sourcesAnalyzed: number;
  maxUpdatedAt: number;
  pairs: SourceCandidatePair[];
}

export const pairCheckpointId = (pair: SourceCandidatePair): string =>
  `link_analysis:${pair.sourceA.id}:${pair.sourceB.id}`;

export function readLinkBatch(sdk: ShaleSDK): LinkBatch | undefined {
  return sdk.checkpoint.get<LinkBatch>(BATCH_ID)?.data;
}

/** Invoke inside the graph commit transaction so progress never outruns persistence. */
export function completeLinkPairs(sdk: ShaleSDK, completed: Set<string>): void {
  const batch = readLinkBatch(sdk);
  if (!batch) return; // Legacy pair checkpoints cannot prove a complete batch.
  const pairs = batch.pairs.filter((pair) => !completed.has(pairCheckpointId(pair)));
  if (pairs.length) {
    sdk.saveCheckpoint({ ...batch, pairs }, { id: BATCH_ID, key: BATCH_ID });
    return;
  }
  const watermark = Number(sdk.state.getWatermark(WATERMARK_KEY) ?? "0");
  if (batch.maxUpdatedAt > watermark)
    sdk.state.setWatermark(String(batch.maxUpdatedAt), WATERMARK_KEY);
  sdk.deleteCheckpoint(BATCH_ID);
}
