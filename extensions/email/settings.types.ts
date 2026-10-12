import type { ChatWindowSettings } from "@shale/sdk/chat/types";

export interface EmailSettings extends ChatWindowSettings {
  importDir?: string;
  syncEnabled?: boolean;
  host?: string;
  port?: number;
  username?: string;
  passwordEnv?: string;
  mailboxes?: string[];
  initialSyncDays?: number;
  maxMessagesPerMailbox?: number;
  pythonBin?: string;
  syncTimeoutMinutes?: number;
  namespace?: string;
}

export const EMAIL_DEFAULTS = {
  importDir: "./data/email/import",
  syncEnabled: true,
  host: "",
  port: 993,
  username: "",
  passwordEnv: "EMAIL_PASSWORD",
  mailboxes: ["INBOX"],
  initialSyncDays: 0,
  maxMessagesPerMailbox: 200,
  pythonBin: "python3",
  syncTimeoutMinutes: 10,
  namespace: "email",
  gapMinutes: 1440,
  maxWindowMessages: 50,
  maxWindowChars: 11000,
  idleMinutes: 0,
  maxWindowsPerRun: 50,
  summarize: true,
  llmModel: "",
  excludeBots: false,
};
