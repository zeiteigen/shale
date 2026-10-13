import type { ChatWindowSettings } from "@shale/sdk/chat/types";

export type DiscordThreadMode = "none" | "active" | "all";
export type DiscordSyncScope = "all" | "selected";

export interface DiscordSettings extends ChatWindowSettings {
  importDir?: string;
  syncEnabled?: boolean;
  syncScope?: DiscordSyncScope;
  dceCommand?: string[];
  tokenEnv?: string;
  channels?: string[];
  guilds?: string[];
  includeDMs?: boolean;
  includeThreads?: DiscordThreadMode;
  initialSyncDays?: number;
  downloadMedia?: boolean;
  exportDir?: string;
  keepExports?: boolean;
  syncTimeoutMinutes?: number;
  exportParallel?: number;
  namespace?: string;
  relevanceEnabled?: boolean;
  selfUserIds?: string[];
  interests?: string[];
  excludedTopics?: string[];
  includedPeople?: string[];
  excludedPeople?: string[];
  includedConversations?: string[];
  excludedConversations?: string[];
  interestProfile?: string;
  relevanceThreshold?: number;
  relevanceModel?: string;
  rawRetentionDays?: number;
  rawMaxMiB?: number;
  rawMaxConversationMessages?: number;
  syncBudgetMinutes?: number;
  syncMaxRequests?: number;
  syncMaxMessages?: number;
  relevanceMaxWindows?: number;
  relevanceMaxLLMCalls?: number;
  backfillMaxMessages?: number;
}

export const DISCORD_DEFAULTS = {
  importDir: "./data/discord/import",
  exportDir: "./data/discord/exports",
  tokenEnv: "DISCORD_TOKEN",
  syncScope: "all" as DiscordSyncScope,
  includeThreads: "all" as DiscordThreadMode,
  initialSyncDays: 0,
  syncTimeoutMinutes: 120,
  exportParallel: 3,
};

export const RELEVANCE_DEFAULTS = {
  relevanceEnabled: true,
  selfUserIds: [] as string[],
  interests: [] as string[],
  excludedTopics: [] as string[],
  includedPeople: [] as string[],
  excludedPeople: [] as string[],
  includedConversations: [] as string[],
  excludedConversations: [] as string[],
  interestProfile: "local",
  relevanceThreshold: 0.75,
  relevanceModel: "",
  rawRetentionDays: 30,
  rawMaxMiB: 256,
  rawMaxConversationMessages: 5000,
  syncBudgetMinutes: 10,
  syncMaxRequests: 100,
  syncMaxMessages: 5000,
  relevanceMaxWindows: 50,
  relevanceMaxLLMCalls: 25,
  backfillMaxMessages: 1000,
};
