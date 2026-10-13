import type { ShaleSDK } from "@shale/sdk";
import { ChatStore } from "@shale/sdk/chat/store";
import type { ChatConnector } from "@shale/sdk/chat/commit";
import { PROVIDER_IDS, PROVIDERS, type Provider } from "./contract";
import { AI_CHATS_DEFAULTS, type AiChatsSettings } from "./settings.types";

export function aiChatsSettings(sdk: ShaleSDK): AiChatsSettings {
  return sdk.settings.getAll<AiChatsSettings>();
}

export function enabledProviders(settings: AiChatsSettings): Provider[] {
  const listed = settings.providers ?? AI_CHATS_DEFAULTS.providers;
  return PROVIDER_IDS.filter(provider => listed.includes(provider));
}

/**
 * One connector per provider: the platform is the source origin (so access policies and
 * refresh requests address `chatgpt`, `claude`, or `gemini`), and each provider keeps its own
 * tables because window scans cover every conversation in a store.
 */
export function aiChatConnector(sdk: ShaleSDK, provider: Provider, settings = aiChatsSettings(sdk)): ChatConnector {
  return {
    platform: provider,
    namespace: settings.namespace || sdk.namespace,
    store: new ChatStore(sdk.database, sdk.extensionId, `ai_${provider}`),
  };
}

export function aiChatConnectors(sdk: ShaleSDK, settings = aiChatsSettings(sdk)) {
  return PROVIDER_IDS.map(provider => aiChatConnector(sdk, provider, settings));
}

export const assistantName = (provider: Provider) => PROVIDERS[provider].label;
export const conversationUri = (provider: Provider, conversationId: string) =>
  `${provider}://conversation/${encodeURIComponent(conversationId)}`;
