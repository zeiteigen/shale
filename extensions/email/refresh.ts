import type { ShaleSDK } from "@shale/sdk";
import { setupChatRefresh } from "@shale/sdk/chat/refresh";
import { emailConnector, emailSettings } from "./connector";

export function setup(sdk: ShaleSDK) {
  setupChatRefresh(sdk, () => emailConnector(sdk), () => emailSettings(sdk));
}
