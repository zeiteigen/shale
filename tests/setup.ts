import { afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "../sdk/settings";

// Host/ambient SDK tests must never mutate the user's production index.
const directory = mkdtempSync(join(tmpdir(), "shale-tests-"));
process.env.SHALE_DB_PATH = join(directory, "test.db");
process.env.SHALE_SETTINGS_PATH = join(directory, "settings.json");
writeFileSync(process.env.SHALE_SETTINGS_PATH, "{}\n");

// Host imports initialize db-backup, even though the database itself is isolated.
// Redirect that extension's output so test startup cannot prune the user's backups.
const backupSettingsPath = join(import.meta.dir, "../extensions/db-backup/settings.json");
const readSettings = SettingsManager.prototype.getAll;
SettingsManager.prototype.getAll = function <R>() {
  const settings = readSettings.call(this) as Record<string, unknown>;
  return (this.getSettingsPath() === backupSettingsPath
    ? { ...settings, backupDir: join(directory, "backups") }
    : settings) as R;
};
afterAll(() => rmSync(directory, { recursive: true, force: true }));
