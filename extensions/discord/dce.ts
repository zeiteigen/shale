import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ShaleSDK } from "@shale/sdk";
import type { ChatConnector } from "@shale/sdk/chat/commit";
import { resolveDataPath } from "@shale/sdk/chat/paths";
import { DISCORD_DEFAULTS, type DiscordSettings } from "./settings.types";
import { ProgressiveImport } from "./progressive-import";
import { discordToken } from "./auth";
import { dceCommand } from "./dce-binary";
import { Exporter, PartialExportError } from "./dce-runner";
import { LAST_SYNC_KEY } from "./connector";

const LIST_TIMEOUT_MS = 5 * 60_000;
/** Channels the account cannot read are retried after this long instead of on every run. */
const FORBIDDEN_RETRY_MS = 7 * 86_400_000;

export interface SyncChannel { id: string; label: string }

/** Parse DiscordChatExporter listing output: `<id> | <name>` per line (threads may be indented or bulleted). */
export function parseListing(output: string): Array<{ id: string; name: string }> {
  return output.split("\n").flatMap(line => {
    const match = line.match(/^[\s*•-]*(\d{1,20})\s*\|\s*(.*)$/);
    return match && match[1] !== "0" ? [{ id: match[1]!, name: match[2]!.trim() }] : [];
  });
}

/**
 * Channels to sync: configured channels and servers, plus — with syncScope "all" —
 * every server and (for user tokens) every DM the account can see.
 */
export async function discoverChannels(exporter: Exporter, settings: DiscordSettings, tokenKind: string | undefined) {
  const all = (settings.syncScope ?? DISCORD_DEFAULTS.syncScope) === "all";
  const channels = new Map<string, string>();
  for (const id of settings.channels ?? []) if (id) channels.set(id, `channel ${id}`);
  const guilds = new Map<string, string>((settings.guilds ?? []).filter(Boolean).map(id => [id, id]));
  if (all) for (const guild of parseListing(await exporter.run(["guilds"], LIST_TIMEOUT_MS))) guilds.set(guild.id, guild.name);
  for (const [id, name] of guilds)
    for (const channel of parseListing(await exporter.run(["channels", "-g", id], LIST_TIMEOUT_MS)))
      channels.set(channel.id, `${name} › ${channel.name}`);
  if ((all || settings.includeDMs) && tokenKind !== "bot")
    for (const dm of parseListing(await exporter.run(["dm"], LIST_TIMEOUT_MS))) channels.set(dm.id, `DM ${dm.name}`);
  return [...channels].map(([id, label]) => ({ id, label }));
}

/** Arguments to export one channel (and its threads) since its watermark, or `initialSyncDays` on first sync. */
export function exporterArgs(channelId: string, outDir: string, settings: DiscordSettings, watermark: string | null, now = Date.now()) {
  const days = settings.initialSyncDays ?? DISCORD_DEFAULTS.initialSyncDays;
  const after = watermark ?? (days > 0 ? new Date(now - days * 86_400_000).toISOString() : null);
  const threads = settings.includeThreads ?? DISCORD_DEFAULTS.includeThreads;
  const args = ["export", "-c", channelId, "-f", "Json", "-o", join(outDir, "%c.json")];
  if (threads !== "none") args.push("--include-threads", threads === "active" ? "Active" : "All");
  if (after) args.push("--after", after);
  const parallel = Math.max(1, Math.floor(settings.exportParallel ?? DISCORD_DEFAULTS.exportParallel));
  if (parallel > 1) args.push("--parallel", String(parallel));
  if (settings.downloadMedia) args.push("--media", "--reuse-media", "--media-dir", join(resolveDataPath(settings.exportDir ?? DISCORD_DEFAULTS.exportDir), "media"));
  return args;
}

export interface SyncResult { channels: number; skipped: number; messages: number; errors: string[] }

/** Export every channel since its own watermark and ingest the files; an interrupted sweep resumes per channel. */
export async function syncDiscord(sdk: ShaleSDK, connector: ChatConnector, settings: DiscordSettings,
  /** Runs after each channel that brought new messages, e.g. to index them before the sweep ends. */
  afterChannel?: () => Promise<void>): Promise<SyncResult> {
  const result: SyncResult = { channels: 0, skipped: 0, messages: 0, errors: [] };
  const token = discordToken(sdk);
  if (!token) {
    sdk.logger.warn("Discord sync skipped: no account is connected. Connect Discord on the Accounts page of the Shale web interface.");
    return result;
  }
  const exporter = new Exporter(dceCommand(settings), token);
  const root = resolveDataPath(settings.exportDir ?? DISCORD_DEFAULTS.exportDir);
  const timeout = (settings.syncTimeoutMinutes ?? DISCORD_DEFAULTS.syncTimeoutMinutes) * 60_000;
  const startedAt = Date.now();
  let channels: SyncChannel[];
  try {
    channels = await discoverChannels(exporter, settings, sdk.credentials.get("kind"));
  } catch (error) {
    result.errors.push(`listing channels: ${error instanceof Error ? error.message : String(error)}`);
    sdk.logger.error("Discord sync could not list channels:", error);
    sdk.state.setJson(LAST_SYNC_KEY, { ...result, errors: result.errors.length, startedAt, finishedAt: Date.now() });
    return result;
  }
  if (!channels.length) sdk.logger.warn("Discord sync found no channels. Set syncScope to \"all\", or list channels/guilds in the discord settings.");
  else sdk.logger.log(`Discord sync: ${channels.length} channel(s) to check.`);
  for (const [index, channel] of channels.entries()) {
    const forbiddenAt = Number(sdk.state.getWatermark(`forbidden:${channel.id}`) ?? 0);
    if (forbiddenAt && Date.now() - forbiddenAt < FORBIDDEN_RETRY_MS) { result.skipped++; continue; }
    const outDir = join(root, `run-${startedAt}`, channel.id);
    const stateKey = `sync:channel:${channel.id}`;
    try {
      await mkdir(outDir, { recursive: true });
      let partial: PartialExportError | undefined;
      // Thread-heavy channels (forums) take a long time; ingest each finished file while the export continues.
      const ingest = new ProgressiveImport(sdk, connector, outDir, afterChannel);
      const exporting = exporter.run(exporterArgs(channel.id, outDir, settings, sdk.state.getWatermark(stateKey)), timeout)
        .finally(() => ingest.stop());
      // Even if indexing fails, let the exporter finish before cleaning up its output directory.
      const [watching, exported] = await Promise.allSettled([ingest.watch(), exporting]);
      if (watching.status === "rejected") throw watching.reason;
      if (exported.status === "rejected") {
        if (!(exported.reason instanceof PartialExportError)) throw exported.reason;
        partial = exported.reason;
      }
      const { newest, changed } = await ingest.finish();
      // Advance only after every file committed; re-fetching one second keeps same-second messages.
      if (newest && !partial) sdk.state.setWatermark(new Date(newest - 1000).toISOString(), stateKey);
      sdk.state.delete(`forbidden:${channel.id}`);
      result.channels++;
      result.messages += changed;
      if (partial) {
        result.errors.push(`${channel.label}: ${partial.message}`);
        sdk.logger.error(`Discord sync incomplete for ${channel.label}:`, partial.message);
      }
      if (changed) {
        sdk.logger.log(`Discord sync [${index + 1}/${channels.length}] ${channel.label}: ${changed} new/edited message(s)`
          + `${ingest.files > 1 ? ` in ${ingest.files} file(s) (channel + threads)` : ""}.`);
        await afterChannel?.();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/forbidden|missing access|unauthorized to view/i.test(message)) {
        sdk.state.setWatermark(String(Date.now()), `forbidden:${channel.id}`);
        result.skipped++;
      } else {
        result.errors.push(`${channel.label}: ${message}`);
        sdk.logger.error(`Discord sync failed for ${channel.label}:`, message);
      }
    } finally {
      if (!settings.keepExports) await rm(outDir, { recursive: true, force: true });
    }
  }
  if (!settings.keepExports) await rm(join(root, `run-${startedAt}`), { recursive: true, force: true });
  sdk.state.setJson(LAST_SYNC_KEY, { ...result, errors: result.errors.length, startedAt, finishedAt: Date.now() });
  return result;
}
