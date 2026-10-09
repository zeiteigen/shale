import { expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getRootSettingsPath } from "../lib/settings";

it("defaults host settings to data while preserving explicit path overrides", () => {
  const previous = process.env.SHALE_SETTINGS_PATH;
  try {
    delete process.env.SHALE_SETTINGS_PATH;
    expect(getRootSettingsPath()).toBe(join(import.meta.dir, "../data/settings.json"));
    process.env.SHALE_SETTINGS_PATH = "/tmp/custom-settings.json";
    expect(getRootSettingsPath()).toBe("/tmp/custom-settings.json");
  } finally {
    if (previous === undefined) delete process.env.SHALE_SETTINGS_PATH;
    else process.env.SHALE_SETTINGS_PATH = previous;
  }
});

it("loads data/.env outside the project cwd, preserves environment overrides, and tolerates a missing file", () => {
  const directory = mkdtempSync(join(tmpdir(), "shale-data-env-"));
  try {
    mkdirSync(join(directory, "lib"));
    mkdirSync(join(directory, "data"));
    const loader = join(directory, "lib/environment.ts");
    copyFileSync(join(import.meta.dir, "../lib/environment.ts"), loader);
    writeFileSync(join(directory, "data/.env"), 'SHALE_TEST_FILE_VALUE="from file"\nSHALE_TEST_OVERRIDE=file\n');
    const env: NodeJS.ProcessEnv = { ...process.env, SHALE_TEST_OVERRIDE: "shell" };
    delete env.SHALE_TEST_FILE_VALUE;
    const run = (code: string) => spawnSync("bun", ["-e", code], { cwd: tmpdir(), env, encoding: "utf8" });
    const result = run(`await import(${JSON.stringify(loader)}); console.log(JSON.stringify([process.env.SHALE_TEST_FILE_VALUE, process.env.SHALE_TEST_OVERRIDE]));`);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["from file", "shell"]);
    rmSync(join(directory, "data/.env"));
    expect(run(`await import(${JSON.stringify(loader)});`).status).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
