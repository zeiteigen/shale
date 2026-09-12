import { homedir } from "node:os";
import { join, basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { logger } from "@shale/sdk";

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
 * Discovers all active Obsidian vaults configured on the system.
 *
 * @param configPath Optional path override for obsidian.json (useful for testing)
 */
export function discoverVaults(configPath?: string): VaultInfo[] {
  const targetPath = configPath ?? getObsidianConfigPath();

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
