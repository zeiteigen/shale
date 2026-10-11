import { getSDK, type CheckpointContext, type ShaleSDK } from "@shale/sdk";
import { recoverChatWindows, withChatLease } from "@shale/sdk/chat/commit";
import type { PreparedChatWindow } from "@shale/sdk/chat/types";
import { instagramConnector } from "./connector";

export async function run(sdkOverride?: ShaleSDK, contextOverride?: CheckpointContext<PreparedChatWindow>) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const context = contextOverride ?? sdk.getCheckpointContext<PreparedChatWindow>();
  const result = await withChatLease(sdk, () => recoverChatWindows(sdk, instagramConnector(sdk), context));
  if (result === null) throw new Error("Instagram ingestion is running; recovery will retry");
  return result;
}

if (import.meta.main) {
  run().catch(error => { console.error("Instagram recovery failed:", error); process.exitCode = 1; });
}

export default run;
