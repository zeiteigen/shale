import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveDataPath } from "@shale/sdk/chat/paths";
import type { DiscordSettings } from "./settings.types";

/** Release installed by `bun run setup discord`; override with DCE_VERSION at setup time. */
export const DCE_VERSION = "2.48";
export const DCE_DIR = resolveDataPath("./data/discord/dce");
export const DCE_BINARY = join(DCE_DIR, process.platform === "win32" ? "DiscordChatExporter.Cli.exe" : "DiscordChatExporter.Cli");

/** An explicit dceCommand wins; otherwise the setup download, then a CLI on PATH. */
export function dceCommand(settings: DiscordSettings): string[] {
  if (settings.dceCommand?.length) return settings.dceCommand;
  return [existsSync(DCE_BINARY) ? DCE_BINARY : "DiscordChatExporter.Cli"];
}
