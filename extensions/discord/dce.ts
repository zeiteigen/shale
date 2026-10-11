import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ShaleSDK } from "@shale/sdk";
import type { ChatConnector } from "@shale/sdk/chat/commit";
import { resolveDataPath } from "@shale/sdk/chat/paths";
import { DISCORD_DEFAULTS, type DiscordSettings } from "./settings.types";
import { importExportFile, jsonFiles } from "./import-folder";
import { discordToken } from "./auth";

export interface SyncTarget {
  /** Watermark key, e.g. `channel:123`, `guild:456`, `dm`. */
  key: string;
  args: string[];
}

export function syncTargets(settings: DiscordSettings): SyncTarget[] {
  const threads = settings.includeThreads ?? DISCORD_DEFAULTS.includeThreads;
  const threadArgs = threads === "none" ? [] : ["--include-threads", threads === "active" ? "Active" : "All"];
  return [
    ...(settings.channels ?? []).filter(Boolean).map(id => ({ key: `channel:${id}`, args: ["export", "-c", id, ...threadArgs] })),
    ...(settings.guilds ?? []).filter(Boolean).map(id => ({ key: `guild:${id}`, args: ["exportguild", "-g", id, ...threadArgs] })),
    ...(settings.includeDMs ? [{ key: "dm", args: ["exportdm"] }] : []),
  ];
}

/** Arguments for one exporter run; `--after` comes from the target's watermark or `initialSyncDays`. */
export function exporterArgs(target: SyncTarget, outDir: string, settings: DiscordSettings, watermark: string | null, now = Date.now()) {
  const days = settings.initialSyncDays ?? DISCORD_DEFAULTS.initialSyncDays;
  const after = watermark ?? (days > 0 ? new Date(now - days * 86_400_000).toISOString() : null);
  const args = [...target.args, "-f", "Json", "-o", join(outDir, "%c.json")];
  if (after) args.push("--after", after);
  if (settings.downloadMedia) args.push("--media", "--reuse-media", "--media-dir", join(resolveDataPath(settings.exportDir ?? DISCORD_DEFAULTS.exportDir), "media"));
  return args;
}

async function runExporter(command: string[], args: string[], token: string, timeoutMs: number) {
  const child = Bun.spawn([...command, ...args], {
    // DiscordChatExporter reads DISCORD_TOKEN itself; keeping it off argv hides it from process listings.
    env: { ...process.env, DISCORD_TOKEN: token }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  if (code !== 0) {
    const detail = `${stderr}\n${stdout}`.split(token).join("***").trim().split("\n").slice(-8).join("\n");
    throw new Error(`DiscordChatExporter exited with ${child.signalCode ?? code}: ${detail}`);
  }
}

export interface SyncResult { targets: number; messages: number; errors: string[] }

/** Export each configured target since its watermark and ingest the produced JSON files. */
export async function syncDiscord(sdk: ShaleSDK, connector: ChatConnector, settings: DiscordSettings): Promise<SyncResult> {
  const result: SyncResult = { targets: 0, messages: 0, errors: [] };
  const token = discordToken(sdk);
  if (!token) {
    sdk.logger.warn("Discord sync is enabled but no account is connected. Connect Discord on the Accounts page of the Shale web interface. Skipping sync.");
    return result;
  }
  const command = settings.dceCommand?.length ? settings.dceCommand : DISCORD_DEFAULTS.dceCommand;
  const root = resolveDataPath(settings.exportDir ?? DISCORD_DEFAULTS.exportDir);
  const timeout = (settings.syncTimeoutMinutes ?? DISCORD_DEFAULTS.syncTimeoutMinutes) * 60_000;
  for (const target of syncTargets(settings)) {
    const outDir = join(root, `run-${Date.now()}-${target.key.replace(/[^a-z0-9]+/gi, "-")}`);
    const stateKey = `sync:${target.key}`;
    try {
      await mkdir(outDir, { recursive: true });
      await runExporter(command, exporterArgs(target, outDir, settings, sdk.state.getWatermark(stateKey)), token, timeout);
      let newest = 0;
      for await (const path of jsonFiles(outDir)) {
        const imported = await importExportFile(connector, path);
        result.messages += imported.changed;
        newest = Math.max(newest, imported.newest);
      }
      // Advance only after every file committed; re-fetching one second keeps same-second messages.
      if (newest) sdk.state.setWatermark(new Date(newest - 1000).toISOString(), stateKey);
      result.targets++;
      if (!settings.keepExports) await rm(outDir, { recursive: true, force: true });
    } catch (error) {
      result.errors.push(`${target.key}: ${error instanceof Error ? error.message : String(error)}`);
      sdk.logger.error(`Discord sync failed for ${target.key}:`, error);
    }
  }
  return result;
}
