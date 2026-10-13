import { getSDK, type ShaleSDK } from "@shale/sdk";
import { indexChatWindows, withChatLease } from "@shale/sdk/chat/commit";
import { discordConnector, discordSettings } from "./connector";
import { syncDiscord } from "./dce";

/** Fetch new messages with DiscordChatExporter (when enabled), then index sealed windows. */
export async function run(sdkOverride?: ShaleSDK) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const settings = discordSettings(sdk);
  if (settings.syncEnabled === false) {
    sdk.logger.log("Discord sync is disabled (syncEnabled is false in the discord settings).");
    return null;
  }
  const connector = discordConnector(sdk, settings);
  return withChatLease(sdk, async () => {
    // Index as channels arrive so a long first sweep becomes searchable progressively.
    const indexed = { windows: 0, indexed: 0, errors: [] as string[] };
    const index = async () => {
      const result = await indexChatWindows(sdk, connector, settings);
      indexed.windows += result.windows; indexed.indexed += result.indexed; indexed.errors.push(...result.errors);
    };
    const synced = await syncDiscord(sdk, connector, settings, index);
    await index();
    sdk.logger.log(`Discord sync: ${synced.channels} channel(s) checked, ${synced.skipped} skipped, ${synced.messages} new/edited messages, `
      + `indexed ${indexed.indexed} window(s), ${synced.errors.length + indexed.errors.length} error(s).`);
    return { synced, indexed };
  });
}

if (import.meta.main) {
  run().catch(error => { console.error("Discord sync failed:", error); process.exitCode = 1; });
}

export default run;
