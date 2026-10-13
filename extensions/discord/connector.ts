import type { ShaleSDK } from "@shale/sdk";
import { ChatStore } from "@shale/sdk/chat/store";
import type { ChatConnector } from "@shale/sdk/chat/commit";
import type { DiscordSettings } from "./settings.types";
import { DiscordRelevancePolicy } from "./relevance";

export const PLATFORM = "discord";

export function discordSettings(sdk: ShaleSDK): DiscordSettings {
  return sdk.settings.getAll<DiscordSettings>();
}

export function discordConnector(sdk: ShaleSDK, settings = discordSettings(sdk)): ChatConnector {
  const store=new ChatStore(sdk.database,sdk.extensionId,"discord");
  return { platform: PLATFORM, namespace: settings.namespace || sdk.namespace, store,
    policy:new DiscordRelevancePolicy(sdk,store,Date.now()+(settings.syncBudgetMinutes ?? 10)*60_000) };
}
export const LAST_SYNC_KEY = "sync:last";
