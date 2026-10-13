import { getSDK, type ShaleSDK } from "@shale/sdk";
import { indexChatWindows, withChatLease } from "@shale/sdk/chat/commit";
import { resolveDataPath } from "@shale/sdk/chat/paths";
import { discordConnector, discordSettings } from "./connector";
import { importFolder } from "./import-folder";
import { DISCORD_DEFAULTS } from "./settings.types";
import { DiscordRelevancePolicy } from "./relevance";
import { trimDiscordArchive } from "./archive";
import { reclassifyArchived } from "./reclassify-archived";
export { run as recover } from "./recover";
export { run as sync } from "./sync";

/** Import exports dropped into importDir, then index every sealed conversation window. */
export async function run(sdkOverride?: ShaleSDK, force = false) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const settings = discordSettings(sdk);
  const connector = discordConnector(sdk, settings);
  return withChatLease(sdk, async () => {
    const policy=connector.policy as DiscordRelevancePolicy | undefined;
    const imported = await importFolder(sdk, connector, resolveDataPath(settings.importDir ?? DISCORD_DEFAULTS.importDir), force);
    await policy?.start();
    const indexed = await indexChatWindows(sdk, connector, settings,
      {maxWindows:settings.relevanceMaxWindows ?? 50,deadline:policy?.deadline});
    if (policy) {
      const archived=await reclassifyArchived(policy,(settings.relevanceMaxWindows ?? 50)-indexed.windows);
      indexed.windows+=archived.windows;indexed.errors.push(...archived.errors);
      policy.stats.evicted=trimDiscordArchive(sdk,connector.store,discordSettings(sdk)).evicted;
      sdk.state.setJson("relevance:last",policy.stats);
    }
    sdk.logger.log(`Discord: imported ${imported.files} file(s) (${imported.messages} new/edited messages), `
      + `indexed ${indexed.indexed} conversation window(s), ${imported.errors.length + indexed.errors.length} error(s).`);
    return { imported, indexed };
  });
}

if (import.meta.main) {
  run().catch(error => { console.error("Discord ingestion failed:", error); process.exitCode = 1; });
}

export default run;
