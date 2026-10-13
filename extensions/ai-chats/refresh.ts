import type { ShaleSDK } from "@shale/sdk";
import { setupChatRefresh } from "@shale/sdk/chat/refresh";
import { PROVIDER_IDS } from "./contract";
import { aiChatConnector, aiChatsSettings } from "./connector";

/** One `source:refresh` handler per provider, each named after the origin it serves. */
export function setup(sdk: ShaleSDK) {
  for (const provider of PROVIDER_IDS)
    setupChatRefresh(sdk, () => aiChatConnector(sdk, provider), () => aiChatsSettings(sdk));
}
