import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getSDK, type ShaleSDK } from "@shale/sdk";
import type { DbBackupSettings, BackupResult } from "./settings.types";
import type { IngestMaterial } from "../../lib/ingest.types";

export * from "./settings.types";

/**
 * Formats a timestamp string suitable for safe filenames.
 */
export function formatTimestamp(
  format: "iso" | "unix" = "iso",
  date: Date = new Date(),
): string {
  if (format === "unix") {
    return String(date.getTime());
  }

  // ISO timestamp sanitized for file systems: YYYY-MM-DDTHH-mm-ss
  return date
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\..+/, "")
    .replace("Z", "");
}

/**
 * Prunes older database backups exceeding the maxBackups limit.
 */
export function pruneOldBackups(
  backupDir: string,
  filenamePrefix: string,
  maxBackups: number,
  logger?: { info: (...args: any[]) => void; warn?: (...args: any[]) => void },
): number {
  if (maxBackups <= 0 || !existsSync(backupDir)) {
    return 0;
  }

  try {
    const files = readdirSync(backupDir);
    const backupFiles = files
      .filter((f) => f.startsWith(filenamePrefix) && f.endsWith(".db"))
      .map((filename) => {
        const fullPath = join(backupDir, filename);
        const stats = statSync(fullPath);
        return {
          filename,
          fullPath,
          mtimeMs: stats.mtimeMs,
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // Sort descending: newest first

    let pruned = 0;
    for (let i = maxBackups; i < backupFiles.length; i++) {
      try {
        unlinkSync(backupFiles[i].fullPath);
        pruned++;
        logger?.info(`Pruned older database backup: ${backupFiles[i].filename}`);
      } catch (err: any) {
        logger?.warn?.(
          `Failed to delete old backup ${backupFiles[i].filename}:`,
          err?.message || err,
        );
      }
    }

    return pruned;
  } catch (err: any) {
    logger?.warn?.("Error checking old backups for pruning:", err?.message || err);
    return 0;
  }
}

/**
 * Core backup execution routine.
 */
export async function executeBackup(
  sdk: ShaleSDK,
  options?: Partial<DbBackupSettings>,
): Promise<BackupResult> {
  const currentSettings = sdk.settings.getAll<DbBackupSettings>();
  const settings: DbBackupSettings = {
    enabled: currentSettings.enabled ?? true,
    backupOnStartup: currentSettings.backupOnStartup ?? true,
    backupDir: currentSettings.backupDir || "./data/backups",
    filenamePrefix: currentSettings.filenamePrefix || "production-backup-",
    maxBackups: currentSettings.maxBackups ?? 10,
    timestampFormat: currentSettings.timestampFormat || "iso",
    ...options,
  };

  if (!settings.enabled) {
    sdk.logger.info("Database backup skipped (disabled in settings).");
    return {
      success: true,
      skipped: true,
      reason: "disabled in settings",
    };
  }

  const targetDir = isAbsolute(settings.backupDir)
    ? settings.backupDir
    : resolve(import.meta.dir, "../..", settings.backupDir);

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
    sdk.logger.info(`Created backup directory: ${targetDir}`);
  }

  const ts = formatTimestamp(settings.timestampFormat);
  let filename = `${settings.filenamePrefix}${ts}.db`;
  let targetPath = join(targetDir, filename);

  if (existsSync(targetPath)) {
    // Avoid collision if multiple backups run within the same second
    filename = `${settings.filenamePrefix}${ts}-${Date.now()}.db`;
    targetPath = join(targetDir, filename);
  }

  sdk.logger.info(`Creating database backup -> ${targetPath}...`);
  const startTime = Date.now();

  try {
    // Atomically take a consistent, compacted snapshot of production.db
    sdk.database.run("VACUUM INTO ?", [targetPath]);

    const durationMs = Date.now() - startTime;
    const stats = statSync(targetPath);
    const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);

    sdk.logger.info(
      `Database backup completed successfully in ${durationMs}ms (${sizeMb} MB, ${stats.size} bytes).`,
    );

    // Record metadata in extension_state
    const nowIso = new Date().toISOString();
    sdk.state.setWatermark(nowIso, "last_backup_time");
    sdk.state.set("last_backup_file", targetPath);
    sdk.state.set("last_backup_size", String(stats.size));

    // Prune older backups if configured
    const prunedCount = pruneOldBackups(
      targetDir,
      settings.filenamePrefix,
      settings.maxBackups,
      sdk.logger,
    );

    if (prunedCount > 0) {
      sdk.logger.info(
        `Pruned ${prunedCount} older backup(s). Retaining latest ${settings.maxBackups}.`,
      );
    }

    return {
      success: true,
      backupPath: targetPath,
      filename,
      sizeBytes: stats.size,
      prunedCount,
      timestamp: ts,
    };
  } catch (err: any) {
    sdk.logger.error("Failed to create database backup:", err?.message || err);
    throw err;
  }
}

/**
 * Main extension runner invoked by cron schedules or CLI.
 */
export async function run(
  sdkOverride?: ShaleSDK,
  options?: Partial<DbBackupSettings>,
): Promise<BackupResult> {
  const sdk = sdkOverride ?? getSDK();
  return executeBackup(sdk, options);
}

/**
 * Initialization hook invoked by the host (main/load-extensions.ts) whenever the program launches.
 */
export async function init(): Promise<void> {
  const sdk = getSDK();
  const settings = sdk.settings.getAll<DbBackupSettings>();

  if (settings.enabled && (settings.backupOnStartup ?? true)) {
    sdk.logger.info("Program launch detected: performing startup database backup...");
    await run(sdk);
  }
}

/**
 * Webhook ingestion hook for triggering backups on demand via HTTP POST /ingest.
 */
export async function subscribe(_item?: IngestMaterial): Promise<void> {
  const sdk = getSDK();
  sdk.logger.info("On-demand database backup triggered via ingestion webhook.");
  await run(sdk);
}

// Standalone execution support: `bun extensions/db-backup/index.ts`
if (import.meta.main) {
  run().catch((err) => {
    console.error("Fatal error running db-backup:", err);
    process.exit(1);
  });
}

export default run;
