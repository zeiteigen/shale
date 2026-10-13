import type { ChatWindowSettings } from "@shale/sdk/chat/types";
import type { Provider } from "./contract";

export interface AiChatsSettings extends ChatWindowSettings {
  /** Providers the Chrome module captures and the server accepts. */
  providers?: Provider[];
  /** Display name for your own messages in transcripts and the graph. */
  userName?: string;
  /** Background re-sync of conversation lists while a provider tab is open; 0 turns it off. */
  autoSyncMinutes?: number;
  /** Pause between conversation fetches during a sync. */
  fetchDelayMs?: number;
  /** Most conversations one sync job fetches. */
  maxConversationsPerSync?: number;
  namespace?: string;
}

export const AI_CHATS_DEFAULTS = {
  providers: ["chatgpt", "claude", "gemini"] as Provider[],
  userName: "Me",
  autoSyncMinutes: 360,
  fetchDelayMs: 1500,
  maxConversationsPerSync: 1000,
  namespace: "ai-chats",
};
