import { getSDK, logger, type ShaleSDK } from "@shale/sdk";
import { runWorker } from "./worker";
export { run as runRecover } from "./recover";
export interface SessionAggregatorResult {
  finalizedSessionTitle: string | null;
  pageCount: number;
  processedPayloads?: number;
  queuedPayloads?: number;
}
export async function run(
  sdkOverride?: ShaleSDK,
): Promise<SessionAggregatorResult> {
  return runWorker(sdkOverride ?? getSDK(import.meta.dir));
}
if (import.meta.main)
  run().catch((error) => logger.error("Browser worker failed:", error));
export default run;
