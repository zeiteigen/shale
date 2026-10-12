import { getSDK, type ShaleSDK } from "@shale/sdk";
import { indexChatWindows, withChatLease } from "@shale/sdk/chat/commit";
import { resolveDataPath } from "@shale/sdk/chat/paths";
import { emailConnector, emailSettings } from "./connector";
import { importFolder } from "./import-folder";
export { run as recover } from "./recover";
export { run as sync } from "./sync";

export async function run(sdkOverride?: ShaleSDK, force = false) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const settings = emailSettings(sdk);
  const connector = emailConnector(sdk, settings);
  return withChatLease(sdk, async () => {
    const imported = await importFolder(sdk, connector, settings, resolveDataPath(settings.importDir!), force);
    const indexed = await indexChatWindows(sdk, connector, settings);
    sdk.logger.log(`Email import: ${imported.files} file(s), ${imported.messages} new/edited messages, `
      + `${indexed.indexed} window(s) indexed, ${imported.errors.length + indexed.errors.length} error(s).`);
    return { imported, indexed };
  });
}

if (import.meta.main) run().catch(error => { console.error("Email ingestion failed:", error); process.exitCode = 1; });
export default run;
