import { getSDK, type ShaleSDK } from "@shale/sdk";
import { indexChatWindows, withChatLease } from "@shale/sdk/chat/commit";
import { resolveDataPath } from "@shale/sdk/chat/paths";
import { instagramConnector, instagramSettings } from "./connector";
import { importFolder } from "./import-folder";
import { INSTAGRAM_DEFAULTS } from "./settings.types";
export { run as recover } from "./recover";
export { run as sync } from "./sync";

/** Import exports dropped into importDir, then index every sealed conversation window. */
export async function run(sdkOverride?: ShaleSDK, force = false) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const settings = instagramSettings(sdk);
  const connector = instagramConnector(sdk, settings);
  return withChatLease(sdk, async () => {
    const imported = await importFolder(sdk, connector, resolveDataPath(settings.importDir ?? INSTAGRAM_DEFAULTS.importDir), force);
    const indexed = await indexChatWindows(sdk, connector, settings);
    sdk.logger.log(`Instagram: imported ${imported.files} file(s) (${imported.messages} new/edited messages), `
      + `indexed ${indexed.indexed} conversation window(s), ${imported.errors.length + indexed.errors.length} error(s).`);
    return { imported, indexed };
  });
}

if (import.meta.main) {
  run().catch(error => { console.error("Instagram ingestion failed:", error); process.exitCode = 1; });
}

export default run;
