import type { ShaleSDK } from "@shale/sdk";
import { ChatStore } from "@shale/sdk/chat/store";
import type { ChatConnector } from "@shale/sdk/chat/commit";
import type { DiscordSettings } from "./settings.types";

export const PLATFORM = "discord";

export function discordSettings(sdk: ShaleSDK): DiscordSettings {
  return sdk.settings.getAll<DiscordSettings>();
}

export function discordConnector(sdk: ShaleSDK, settings = discordSettings(sdk)): ChatConnector {
  return { platform: PLATFORM, namespace: settings.namespace || sdk.namespace, store: new ChatStore(sdk.database, sdk.extensionId, "discord") };
}
