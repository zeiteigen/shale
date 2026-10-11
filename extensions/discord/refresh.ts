import type { ShaleSDK } from "@shale/sdk";
import { setupChatRefresh } from "@shale/sdk/chat/refresh";
import { discordConnector, discordSettings } from "./connector";

export function setup(sdk: ShaleSDK) {
  setupChatRefresh(sdk, () => discordConnector(sdk), () => discordSettings(sdk));
}
