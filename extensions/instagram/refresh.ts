import type { ShaleSDK } from "@shale/sdk";
import { setupChatRefresh } from "@shale/sdk/chat/refresh";
import { instagramConnector, instagramSettings } from "./connector";

export function setup(sdk: ShaleSDK) {
  setupChatRefresh(sdk, () => instagramConnector(sdk), () => instagramSettings(sdk));
}
