import { getSDK, type ShaleSDK } from "@shale/sdk";
import { indexChatWindows, withChatLease } from "@shale/sdk/chat/commit";
import { discordConnector, discordSettings } from "./connector";
import { syncDiscord } from "./dce";

/** Fetch new messages with DiscordChatExporter (when enabled), then index sealed windows. */
export async function run(sdkOverride?: ShaleSDK) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const settings = discordSettings(sdk);
  if (!settings.syncEnabled) {
    sdk.logger.log("Discord sync is disabled (set syncEnabled to true to fetch with DiscordChatExporter).");
    return null;
  }
  const connector = discordConnector(sdk, settings);
  return withChatLease(sdk, async () => {
    const synced = await syncDiscord(sdk, connector, settings);
    const indexed = await indexChatWindows(sdk, connector, settings);
    sdk.logger.log(`Discord sync: ${synced.targets} target(s), ${synced.messages} new/edited messages, `
      + `indexed ${indexed.indexed} window(s), ${synced.errors.length + indexed.errors.length} error(s).`);
    return { synced, indexed };
  });
}

if (import.meta.main) {
  run().catch(error => { console.error("Discord sync failed:", error); process.exitCode = 1; });
}

export default run;
