import { getSDK, type CheckpointContext, type ShaleSDK } from "@shale/sdk";
import { recoverChatWindows, withChatLease } from "@shale/sdk/chat/commit";
import type { PreparedChatWindow } from "@shale/sdk/chat/types";
import { aiChatConnectors } from "./connector";

export async function run(sdkOverride?: ShaleSDK, contextOverride?: CheckpointContext<PreparedChatWindow>) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const context = contextOverride ?? sdk.getCheckpointContext<PreparedChatWindow>();
  const result = await withChatLease(sdk, async () => {
    let recoveredWindows = 0;
    // Each connector commits only checkpoints of its own platform.
    for (const connector of aiChatConnectors(sdk))
      recoveredWindows += (await recoverChatWindows(sdk, connector, context)).recoveredWindows;
    return { recoveredWindows };
  });
  if (result === null) throw new Error("AI chat indexing is running; recovery will retry");
  return result;
}

if (import.meta.main) {
  run().catch(error => { console.error("AI chat recovery failed:", error); process.exitCode = 1; });
}

export default run;
