import { getSDK, type ShaleSDK } from "@shale/sdk";
import { indexChatWindows, withChatLease } from "@shale/sdk/chat/commit";
import { aiChatConnectors, aiChatsSettings } from "./connector";
export { run as recover } from "./recover";

/** Index every sealed conversation window of every provider. Capture arrives through subscribe.ts. */
export async function run(sdkOverride?: ShaleSDK) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const settings = aiChatsSettings(sdk);
  return withChatLease(sdk, async () => {
    const totals = { windows: 0, indexed: 0, errors: [] as string[] };
    for (const connector of aiChatConnectors(sdk, settings)) {
      const result = await indexChatWindows(sdk, connector, settings);
      totals.windows += result.windows;
      totals.indexed += result.indexed;
      totals.errors.push(...result.errors.map(error => `${connector.platform}: ${error}`));
    }
    if (totals.windows || totals.errors.length)
      sdk.logger.log(`AI chats: indexed ${totals.indexed} of ${totals.windows} conversation window(s), ${totals.errors.length} error(s).`);
    return totals;
  });
}

if (import.meta.main) {
  run().catch(error => { console.error("AI chat indexing failed:", error); process.exitCode = 1; });
}

export default run;
