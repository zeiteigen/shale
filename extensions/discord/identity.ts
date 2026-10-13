import type { ShaleSDK } from "@shale/sdk";
import type { DiscordSettings } from "./settings.types";

/** A bot's account ID never represents the human whose knowledge base this is. */
export function discordIdentity(sdk: ShaleSDK, settings: DiscordSettings): string[] {
  const connected = sdk.credentials.get("kind") !== "bot" ? sdk.credentials.get("userId") : undefined;
  const resolved = sdk.state.getJson<{id:string;kind:string}>("identity");
  return [...new Set([...(settings.selfUserIds ?? []), connected,
    resolved?.kind === "user" ? resolved.id : undefined].filter((id): id is string => !!id))];
}
