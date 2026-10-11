import { getSDK, type ShaleSDK } from "@shale/sdk";
import { indexChatWindows, withChatLease } from "@shale/sdk/chat/commit";
import { instagramConnector, instagramSettings } from "./connector";
import { syncInstagram } from "./sidecar";

/** Fetch new messages with InstagramChatExporter (when enabled), then index sealed windows. */
export async function run(sdkOverride?: ShaleSDK) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const settings = instagramSettings(sdk);
  if (!settings.syncEnabled) {
    sdk.logger.log("Instagram sync is disabled (set syncEnabled to true to fetch with InstagramChatExporter).");
    return null;
  }
  const connector = instagramConnector(sdk, settings);
  return withChatLease(sdk, async () => {
    const synced = await syncInstagram(sdk, connector, settings);
    const indexed = await indexChatWindows(sdk, connector, settings);
    sdk.logger.log(`Instagram sync: ${synced.threads} thread(s), ${synced.messages} new/edited messages, `
      + `indexed ${indexed.indexed} window(s), ${synced.errors.length + indexed.errors.length} error(s).`);
    return { synced, indexed };
  });
}

if (import.meta.main) {
  run().catch(error => { console.error("Instagram sync failed:", error); process.exitCode = 1; });
}

export default run;
