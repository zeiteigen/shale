import type { ShaleSDK } from "@shale/sdk";
import { ChatStore } from "@shale/sdk/chat/store";
import type { ChatConnector } from "@shale/sdk/chat/commit";
import { EMAIL_DEFAULTS, type EmailSettings } from "./settings.types";

export function emailSettings(sdk: ShaleSDK): EmailSettings {
  return { ...EMAIL_DEFAULTS, ...sdk.settings.getAll<EmailSettings>() };
}

export function emailConnector(sdk: ShaleSDK, settings = emailSettings(sdk)): ChatConnector {
  return { platform: "email", namespace: settings.namespace || sdk.namespace,
    store: new ChatStore(sdk.database, sdk.extensionId, "email") };
}

export const LAST_SYNC_KEY = "sync:last";
