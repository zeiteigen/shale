import { getSDK, type ShaleSDK } from "@shale/sdk";
import { indexChatWindows, withChatLease } from "@shale/sdk/chat/commit";
import { discordConnector, discordSettings } from "./connector";
import { syncDiscordREST } from "./rest-sync";
import { DiscordRelevancePolicy } from "./relevance";
import { trimDiscordArchive } from "./archive";
import { LAST_SYNC_KEY } from "./connector";
import { reclassifyArchived } from "./reclassify-archived";

/** Collect bounded Discord context and index relevant windows under a single run budget. */
export async function run(sdkOverride?: ShaleSDK) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const settings = discordSettings(sdk);
  if (settings.syncEnabled === false) {
    sdk.logger.log("Discord sync is disabled (syncEnabled is false in the discord settings).");
    return null;
  }
  const connector = discordConnector(sdk, settings);
  // Hourly and long-running: wait out an import that is indexing rather than skip the hour.
  return withChatLease(sdk, async () => {
    const deadline=Date.now()+(settings.syncBudgetMinutes ?? 10)*60_000;
    const policy=connector.policy as DiscordRelevancePolicy | undefined;
    await policy?.start();
    if (policy) trimDiscordArchive(sdk,connector.store,settings);
    // Index as channels arrive so a long first sweep becomes searchable progressively.
    const indexed = { windows: 0, indexed: 0, errors: [] as string[] };
    const index = async () => {
      const result = await indexChatWindows(sdk, connector, discordSettings(sdk),
        {maxWindows:(discordSettings(sdk).relevanceMaxWindows ?? 50)-indexed.windows,deadline});
      indexed.windows += result.windows; indexed.indexed += result.indexed; indexed.errors.push(...result.errors);
    };
    const synced = await syncDiscordREST(sdk, connector, settings, deadline, index);
    await policy?.start();
    await index();
    if (policy) {
      const archived=await reclassifyArchived(policy,(discordSettings(sdk).relevanceMaxWindows ?? 50)-indexed.windows);
      indexed.windows+=archived.windows;indexed.errors.push(...archived.errors);
      policy.stats.backfilled=synced.backfilled;
      policy.stats.evicted+=trimDiscordArchive(sdk,connector.store,discordSettings(sdk)).evicted;
      policy.stats.incomplete=synced.incomplete;
      sdk.state.setJson("relevance:last",policy.stats);
    }
    sdk.state.setJson(LAST_SYNC_KEY,{...synced,errors:synced.errors.length,finishedAt:Date.now()});
    sdk.logger.log(`Discord sync: ${synced.channels} channel(s) checked, ${synced.skipped} skipped, ${synced.messages} new/edited messages, `
      + `indexed ${indexed.indexed} window(s), ${synced.errors.length + indexed.errors.length} error(s).`);
    return { synced, indexed };
  }, { waitMs: 30 * 60_000 });
}

if (import.meta.main) {
  run().catch(error => { console.error("Discord sync failed:", error); process.exitCode = 1; });
}

export default run;
