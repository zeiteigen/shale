import { homedir } from "node:os";
import { join, basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { logger, getSetting, type ShaleSDK } from "@shale/sdk";

export interface VaultInfo {
  id: string;
  path: string;
  name: string;
  ts?: number;
  open?: boolean;
}

export interface ObsidianConfig {
  vaults?: Record<
    string,
    {
      path: string;
      ts?: number;
      open?: boolean;
    }
  >;
  cli?: boolean;
}

/**
 * Resolves the path to the Obsidian configuration file.
 */
export function getObsidianConfigPath(): string {
  return join(homedir(), ".config", "obsidian", "obsidian.json");
}

/**
 * Discovers all active Obsidian vaults configured on the system or in settings.json.
 *
 * @param configPath Optional path override for obsidian.json (useful for testing)
 * @param sdkOverride Optional SDK instance override
 */
export function discoverVaults(
  configPath?: string,
  sdkOverride?: ShaleSDK,
): VaultInfo[] {
  // Check customVaults setting first
  const customVaultsSetting =
    sdkOverride?.settings.get<Array<{ name?: string; path: string } | string>>(
      "customVaults",
    ) ?? getSetting("customVaults");

  if (Array.isArray(customVaultsSetting) && customVaultsSetting.length > 0) {
    const customVaults: VaultInfo[] = [];
    for (let i = 0; i < customVaultsSetting.length; i++) {
      const item = customVaultsSetting[i];
      const vPath = typeof item === "string" ? item : item.path;
      const vName =
        (typeof item === "object" ? item.name : undefined) || basename(vPath);
      if (existsSync(vPath)) {
        customVaults.push({
          id: `custom-vault-${i + 1}`,
          path: vPath,
          name: vName,
        });
      }
    }
    if (customVaults.length > 0) {
      return customVaults;
    }
  }

  const configuredPath =
    configPath ??
    sdkOverride?.settings.get<string>("obsidianConfigPath") ??
    getSetting("obsidianConfigPath") ??
    getObsidianConfigPath();

  const targetPath = configuredPath;

  if (!existsSync(targetPath)) {
    return [];
  }

  try {
    const raw = readFileSync(targetPath, "utf-8");
    const parsed = JSON.parse(raw) as ObsidianConfig;

    if (!parsed.vaults || typeof parsed.vaults !== "object") {
      return [];
    }

    const vaults: VaultInfo[] = [];

    for (const [id, info] of Object.entries(parsed.vaults)) {
      if (!info || typeof info.path !== "string") {
        continue;
      }

      if (existsSync(info.path)) {
        vaults.push({
          id,
          path: info.path,
          name: basename(info.path),
          ts: info.ts,
          open: info.open,
        });
      }
    }

    return vaults;
  } catch (err) {
    logger.warn(
      `Failed to parse obsidian.json at ${targetPath}:`,
      err,
    );
    return [];
  }
}

export default discoverVaults;
