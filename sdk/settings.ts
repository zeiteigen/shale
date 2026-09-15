import { join, dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Logger } from "./logger";

/**
 * Settings manager for extensions.
 *
 * Always reads settings.json directly from disk on every invocation so users
 * can update configuration options at runtime without restarting the application.
 */
export class SettingsManager<
  T extends Record<string, any> = Record<string, any>,
> {
  private readonly extensionDir?: string;
  private readonly explicitPath?: string;
  private readonly logger: Logger;

  constructor(extensionDir?: string, explicitPath?: string, logger?: Logger) {
    this.extensionDir = extensionDir;
    this.explicitPath = explicitPath;
    this.logger = logger ?? new Logger("settings");
  }

  /**
   * Resolves the absolute path to settings.json for this extension.
   */
  getSettingsPath(): string | null {
    if (this.explicitPath) {
      return this.explicitPath;
    }
    if (this.extensionDir) {
      return join(this.extensionDir, "settings.json");
    }

    // Fallback: traverse upwards from current working directory
    try {
      let cur = resolve(process.cwd());
      while (cur && cur !== dirname(cur)) {
        const candidate = join(cur, "settings.json");
        if (existsSync(candidate)) {
          return candidate;
        }
        const manifestCandidate = join(cur, "manifest.json");
        if (existsSync(manifestCandidate)) {
          return join(cur, "settings.json");
        }
        cur = dirname(cur);
      }
    } catch {}

    return null;
  }

  /**
   * Reads settings.json fresh from disk on every call.
   * Does NOT cache in memory, guaranteeing hot reload without application restart.
   *
   * @returns The parsed settings object, or an empty object if file is missing or invalid.
   */
  getAll(): T {
    const path = this.getSettingsPath();
    if (!path || !existsSync(path)) {
      return {} as T;
    }

    try {
      const content = readFileSync(path, "utf-8");
      if (!content.trim()) {
        return {} as T;
      }
      return JSON.parse(content) as T;
    } catch (err) {
      this.logger.warn(`Failed to read settings from ${path}:`, err);
      return {} as T;
    }
  }

  /**
   * Retrieves a specific configuration parameter by key.
   * Reads fresh from disk on every call.
   *
   * @param key Setting property key
   * @param defaultValue Optional fallback value if the key is not defined in settings.json
   */
  get<K extends keyof T>(key: K, defaultValue: T[K]): T[K];
  get<V = any>(key: string, defaultValue?: V): V;
  get(key: string, defaultValue?: any): any {
    const all = this.getAll();
    if (all && Object.prototype.hasOwnProperty.call(all, key)) {
      const val = (all as any)[key];
      return val !== undefined ? val : defaultValue;
    }
    return defaultValue;
  }

  /**
   * Checks whether a setting key exists in settings.json on disk.
   */
  has(key: string): boolean {
    const all = this.getAll();
    return all ? Object.prototype.hasOwnProperty.call(all, key) : false;
  }

  /**
   * Explicit reload alias returning fresh settings from disk.
   */
  reload(): T {
    return this.getAll();
  }
}

export default SettingsManager;
