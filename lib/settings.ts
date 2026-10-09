import "./environment";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RootSettings } from "./settings.types";
import { omitRemovedRootSettings } from "./removed-settings";

export function getRootSettingsPath(): string {
  return process.env.SHALE_SETTINGS_PATH ?? join(import.meta.dir, "../data/settings.json");
}

/** Read on every call. Invalid host configuration must never silently select another provider. */
export function readRootSettings(): RootSettings {
  const path = getRootSettingsPath();
  let content: string;
  try { content = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const settings = JSON.parse(content);
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error(`Root settings must be a JSON object: ${path}`);
  if (Object.keys(settings).some(key => key.includes("API_KEY")))
    throw new Error("API keys belong in .env, not root settings.json");
  return omitRemovedRootSettings(settings);
}

/** Disk settings take precedence over same-name environment values. API keys stay in .env. */
export function getRootSetting<K extends keyof RootSettings>(key: K): RootSettings[K] | string | undefined {
  const value = readRootSettings()[key];
  return value ?? process.env[key];
}
