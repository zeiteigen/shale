import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTExtensionManifest } from "../lib/extension";
import { createExtensionSDK } from "../sdk";
import {
  run,
  init,
  executeBackup,
  formatTimestamp,
  pruneOldBackups,
} from "../extensions/db-backup";
import type { DbBackupSettings } from "../extensions/db-backup/settings.types";

describe("db-backup Extension", () => {
  let tempDir: string;
  let testDbFile: string;
  let testDb: Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "shale-backup-test-"));
    testDbFile = join(tempDir, "test-source.db");
    testDb = new Database(testDbFile);
    testDb.run("PRAGMA journal_mode = WAL;");
    testDb.run("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);");
    testDb.run("INSERT INTO items (name) VALUES ('item1'), ('item2');");
    testDb.run(`
      CREATE TABLE IF NOT EXISTS extension_state (
        extension_id TEXT NOT NULL,
        state_key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (extension_id, state_key)
      );
    `);
  });

  afterEach(() => {
    try {
      testDb.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("has a valid extension manifest", () => {
    const manifestPath = join(
      import.meta.dir,
      "../extensions/db-backup/manifest.json",
    );
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(isTExtensionManifest(manifest)).toBe(true);
    expect(manifest.name).toBe("db-backup");
    expect(manifest.subscribe_ingest).toBe("index.ts");
    expect(manifest.crons).toBeArray();
    expect(manifest.crons.length).toBeGreaterThan(0);
    expect(manifest.crons[0].script).toBe("index.ts");
  });

  it("has complete settings and help metadata", () => {
    const settingsPath = join(
      import.meta.dir,
      "../extensions/db-backup/settings.json",
    );
    const helpPath = join(
      import.meta.dir,
      "../extensions/db-backup/settings.help.json",
    );

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const help = JSON.parse(readFileSync(helpPath, "utf-8"));

    expect(settings.enabled).toBe(true);
    expect(settings.backupOnStartup).toBe(true);
    expect(typeof settings.backupDir).toBe("string");
    expect(typeof settings.filenamePrefix).toBe("string");
    expect(typeof settings.maxBackups).toBe("number");

    expect(help.extension).toBe("db-backup");
    expect(help.settings.enabled).toBeDefined();
    expect(help.settings.backupOnStartup).toBeDefined();
    expect(help.settings.backupDir).toBeDefined();
    expect(help.settings.maxBackups).toBeDefined();
  });

  it("formats timestamps properly", () => {
    const d = new Date("2026-09-12T15:30:45.000Z");
    const isoTs = formatTimestamp("iso", d);
    expect(isoTs).toBe("2026-09-12T15-30-45");

    const unixTs = formatTimestamp("unix", d);
    expect(unixTs).toBe(String(d.getTime()));
  });

  it("creates a consistent and valid backup database", async () => {
    const backupDir = join(tempDir, "backups");
    const sdk = createExtensionSDK(
      "db-backup",
      "db-backup",
      testDb,
      undefined,
      undefined,
      "db-backup",
      join(import.meta.dir, "../extensions/db-backup"),
    );

    const result = await executeBackup(sdk, {
      backupDir,
      filenamePrefix: "test-backup-",
      maxBackups: 5,
    });

    expect(result.success).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);

    // Verify backup database content and integrity
    const backupDb = new Database(result.backupPath!);
    const integrity = backupDb.query("PRAGMA integrity_check;").get() as any;
    expect(integrity.integrity_check).toBe("ok");

    const rows = backupDb
      .query<{ id: number; name: string }>("SELECT * FROM items;")
      .all();
    expect(rows.length).toBe(2);
    expect(rows[0].name).toBe("item1");
    expect(rows[1].name).toBe("item2");
    backupDb.close();

    // Verify state records
    expect(sdk.state.getWatermark("last_backup_time")).not.toBeNull();
    expect(sdk.state.get("last_backup_file")).toBe(result.backupPath!);
    expect(Number(sdk.state.get("last_backup_size"))).toBe(result.sizeBytes!);
  });

  it("prunes old backups when exceeding maxBackups", () => {
    const backupDir = join(tempDir, "prune-test");
    mkdirSync(backupDir, { recursive: true });

    // Create 4 dummy backup files with staggered timestamps
    const files = [
      "test-backup-1.db",
      "test-backup-2.db",
      "test-backup-3.db",
      "test-backup-4.db",
    ];

    for (let i = 0; i < files.length; i++) {
      const p = join(backupDir, files[i]);
      writeFileSync(p, "dummy db content");
      // Set distinct modification times
      const now = Date.now() + i * 1000;
      const utimes = require("node:fs").utimesSync;
      utimes(p, now / 1000, now / 1000);
    }

    expect(readdirSync(backupDir).length).toBe(4);

    // Retain only latest 2
    const pruned = pruneOldBackups(backupDir, "test-backup-", 2);
    expect(pruned).toBe(2);

    const remaining = readdirSync(backupDir);
    expect(remaining.length).toBe(2);
    expect(remaining).toContain("test-backup-3.db");
    expect(remaining).toContain("test-backup-4.db");
    expect(remaining).not.toContain("test-backup-1.db");
    expect(remaining).not.toContain("test-backup-2.db");
  });

  it("skips backup when enabled is false", async () => {
    const backupDir = join(tempDir, "skip-test");
    const sdk = createExtensionSDK(
      "db-backup",
      "db-backup",
      testDb,
      undefined,
      undefined,
      "db-backup",
      join(import.meta.dir, "../extensions/db-backup"),
    );

    const result = await executeBackup(sdk, {
      enabled: false,
      backupDir,
    });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(existsSync(backupDir)).toBe(false);
  });
});
