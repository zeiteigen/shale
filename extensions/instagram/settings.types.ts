import type { ChatWindowSettings } from "@shale/sdk/chat/types";

export interface InstagramSettings extends ChatWindowSettings {
  importDir?: string;
  syncEnabled?: boolean;
  pythonBin?: string;
  sessionFile?: string;
  usernameEnv?: string;
  passwordEnv?: string;
  maxThreadsPerSync?: number;
  maxMessagesPerThread?: number;
  syncTimeoutMinutes?: number;
  namespace?: string;
}

export const INSTAGRAM_DEFAULTS = {
  importDir: "./data/instagram/import",
  sessionFile: "./data/instagram/session.json",
  usernameEnv: "INSTAGRAM_USERNAME",
  passwordEnv: "INSTAGRAM_PASSWORD",
  maxThreadsPerSync: 20,
  maxMessagesPerThread: 200,
  syncTimeoutMinutes: 20,
  /** Export timestamps are milliseconds; the private API's are microseconds. Same text within this span is one message. */
  nearDuplicateMs: 2000,
};
