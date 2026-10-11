import type { ChatWindowSettings } from "@shale/sdk/chat/types";

export type DiscordThreadMode = "none" | "active" | "all";

export interface DiscordSettings extends ChatWindowSettings {
  importDir?: string;
  syncEnabled?: boolean;
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
  namespace?: string;
}

export const DISCORD_DEFAULTS = {
  importDir: "./data/discord/import",
  exportDir: "./data/discord/exports",
  dceCommand: ["DiscordChatExporter.Cli"],
  tokenEnv: "DISCORD_TOKEN",
  includeThreads: "all" as DiscordThreadMode,
  initialSyncDays: 30,
  syncTimeoutMinutes: 30,
};
