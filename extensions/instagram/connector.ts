import type { ShaleSDK } from "@shale/sdk";
import { ChatStore } from "@shale/sdk/chat/store";
import type { ChatConnector } from "@shale/sdk/chat/commit";
import type { InstagramSettings } from "./settings.types";

export const PLATFORM = "instagram";

export function instagramSettings(sdk: ShaleSDK): InstagramSettings {
  return sdk.settings.getAll<InstagramSettings>();
}

export function instagramConnector(sdk: ShaleSDK, settings = instagramSettings(sdk)): ChatConnector {
  return { platform: PLATFORM, namespace: settings.namespace || sdk.namespace, store: new ChatStore(sdk.database, sdk.extensionId, "instagram") };
}

/** Both feeds name participants the same way, so the sorted name set recognises one thread across them. */
export function participantMatchKey(names: string[]): string | undefined {
  const clean = [...new Set(names.map(name => name.trim().toLocaleLowerCase()).filter(Boolean))].sort();
  return clean.length ? `people:${JSON.stringify(clean)}` : undefined;
}
