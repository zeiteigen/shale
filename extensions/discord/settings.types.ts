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
