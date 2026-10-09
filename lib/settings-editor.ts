import "./environment";
import path from "node:path";
import fs from "node:fs";
import { omitRemovedRootSettings } from "./removed-settings";
import { modelEndpointUrl } from "./ai/endpoint-url";

export interface SettingHelpItem {
  type: "boolean" | "number" | "string" | "string[]" | "array" | "object" | string;
  description: string;
  default?: any;
  possibleValues?: any[];
  range?: { min?: number; max?: number };
  examples?: any[];
  integer?: boolean;
  format?: "url";
}

export interface SettingsHelp {
  extension: string;
  settings: Record<string, SettingHelpItem>;
}

export interface ExtensionInfo {
  name: string;
  dir: string;
  hasSettings: boolean;
  hasHelp: boolean;
  manifest?: Record<string, any>;
}

/**
 * Locate root directory containing extensions/ and package.json.
 */
export function findProjectRoot(): string {
  let current = process.cwd();
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "package.json")) && fs.existsSync(path.join(current, "extensions"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return process.cwd();
}

/**
 * Find extension directory for a given extension name.
 */
export function getExtensionDir(extensionName: string, rootDir = findProjectRoot()): string {
  if (extensionName === "root") return path.join(rootDir, "data");
  if (!extensionName || extensionName === "." || extensionName === ".." || /[\\/]/.test(extensionName))
    throw new Error("Settings target must be root or an extension name");
  return path.join(rootDir, "extensions", extensionName);
}

function settingsPath(extensionName: string, rootDir: string): string {
  if (extensionName === "root" && path.resolve(rootDir) === path.resolve(import.meta.dir, "..") && process.env.SHALE_SETTINGS_PATH) {
    return process.env.SHALE_SETTINGS_PATH;
  }
  return path.join(getExtensionDir(extensionName, rootDir), "settings.json");
}

/**
 * Discover all extensions under extensions/ directory.
 */
export function discoverExtensions(rootDir = findProjectRoot()): ExtensionInfo[] {
  const extensionsDir = path.join(rootDir, "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return [];
  }
  const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  const results: ExtensionInfo[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const extDir = path.join(extensionsDir, entry.name);
      const manifestPath = path.join(extDir, "manifest.json");
      const settingsPath = path.join(extDir, "settings.json");
      const helpPath = path.join(extDir, "settings.help.json");

      let manifest: Record<string, any> | undefined;
      if (fs.existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        } catch {
          // ignore error
        }
      }

      results.push({
        name: entry.name,
        dir: extDir,
        hasSettings: fs.existsSync(settingsPath),
        hasHelp: fs.existsSync(helpPath),
        manifest,
      });
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/** The root configuration participates in CLI/TUI discovery without becoming an extension. */
export function discoverSettingsTargets(rootDir = findProjectRoot()): ExtensionInfo[] {
  const extensions = discoverExtensions(rootDir);
  const dir = getExtensionDir("root", rootDir);
  const hasSettings = fs.existsSync(settingsPath("root", rootDir));
  const hasHelp = fs.existsSync(path.join(dir, "settings.help.json"));
  return hasSettings || hasHelp ? [{ name: "root", dir, hasSettings, hasHelp,
    manifest: { name: "Shale host", description: "Root model, batching, storage, and server settings." } }, ...extensions] : extensions;
}

/**
 * Load settings.json for an extension.
 */
export function loadSettings(extensionName: string, rootDir = findProjectRoot()): Record<string, any> {
  const extDir = getExtensionDir(extensionName, rootDir);
  if (!fs.existsSync(extDir)) {
    throw new Error(`Extension "${extensionName}" not found at ${extDir}`);
  }
  const filePath = settingsPath(extensionName, rootDir);
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const settings = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return extensionName === "root" ? omitRemovedRootSettings(settings) : settings;
  } catch (err: any) {
    throw new Error(`Failed to parse settings.json for extension "${extensionName}": ${err.message}`);
  }
}

/**
 * Save settings.json for an extension.
 */
export function saveSettings(
  extensionName: string,
  settings: Record<string, any>,
  rootDir = findProjectRoot()
): void {
  const extDir = getExtensionDir(extensionName, rootDir);
  if (!fs.existsSync(extDir)) {
    throw new Error(`Extension "${extensionName}" not found at ${extDir}`);
  }
  const filePath = settingsPath(extensionName, rootDir);
  if (extensionName === "root" && Object.keys(settings).some(key => key.includes("API_KEY")))
    throw new Error("API keys belong in .env, not root settings.json");
  if (extensionName === "root") settings = omitRemovedRootSettings(settings);
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    fs.renameSync(temporary, filePath);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

/**
 * Load settings.help.json for an extension.
 */
export function loadSettingsHelp(
  extensionName: string,
  rootDir = findProjectRoot()
): SettingsHelp | null {
  const extDir = getExtensionDir(extensionName, rootDir);
  const helpPath = path.join(extDir, "settings.help.json");
  if (!fs.existsSync(helpPath)) {
    return null;
  }
  try {
    const help = JSON.parse(fs.readFileSync(helpPath, "utf-8")) as SettingsHelp;
    if (extensionName === "root") help.settings = omitRemovedRootSettings(help.settings);
    return help;
  } catch (err: any) {
    throw new Error(`Failed to parse settings.help.json for extension "${extensionName}": ${err.message}`);
  }
}

/**
 * Validate and coerce string input into appropriate type based on help metadata.
 */
export function parseAndValidateValue(
  rawInput: string,
  helpItem?: SettingHelpItem
): { ok: true; value: any } | { ok: false; error: string } {
  const trimmed = rawInput.trim();

  if (!helpItem) {
    // No metadata: infer JSON or string
    try {
      return { ok: true, value: JSON.parse(rawInput) };
    } catch {
      return { ok: true, value: rawInput };
    }
  }

  const expectedType = helpItem.type;

  if (expectedType === "boolean") {
    const lower = trimmed.toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes" || lower === "on") {
      return { ok: true, value: true };
    }
    if (lower === "false" || lower === "0" || lower === "no" || lower === "off") {
      return { ok: true, value: false };
    }
    return { ok: false, error: `Expected boolean (true/false), received: "${rawInput}"` };
  }

  if (expectedType === "number") {
    if (trimmed === "") {
      return { ok: false, error: "Number cannot be empty" };
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num)) {
      return { ok: false, error: `Expected valid number, received: "${rawInput}"` };
    }
    if (helpItem.integer && !Number.isSafeInteger(num))
      return { ok: false, error: "Expected a safe integer" };
    if (helpItem.range) {
      if (helpItem.range.min !== undefined && num < helpItem.range.min) {
        return { ok: false, error: `Value ${num} is below minimum ${helpItem.range.min}` };
      }
      if (helpItem.range.max !== undefined && num > helpItem.range.max) {
        return { ok: false, error: `Value ${num} exceeds maximum ${helpItem.range.max}` };
      }
    }
    if (helpItem.possibleValues && !helpItem.possibleValues.includes(num)) {
      return {
        ok: false,
        error: `Value ${num} is not one of allowed values: ${helpItem.possibleValues.join(", ")}`,
      };
    }
    return { ok: true, value: num };
  }

  if (expectedType === "string[]") {
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
          return { ok: false, error: `Expected array of strings, received: "${rawInput}"` };
        }
        return { ok: true, value: parsed };
      } catch (err: any) {
        return { ok: false, error: `Invalid JSON array: ${err.message}` };
      }
    }
    // Comma-separated strings
    const items = trimmed
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { ok: true, value: items };
  }

  if (expectedType === "array") {
    try {
      const parsed = JSON.parse(rawInput);
      if (!Array.isArray(parsed)) {
        return { ok: false, error: `Expected array, received non-array JSON` };
      }
      return { ok: true, value: parsed };
    } catch (err: any) {
      return { ok: false, error: `Invalid JSON array: ${err.message}` };
    }
  }

  if (expectedType === "object") {
    try {
      const parsed = JSON.parse(rawInput);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: `Expected JSON object, received non-object` };
      }
      return { ok: true, value: parsed };
    } catch (err: any) {
      return { ok: false, error: `Invalid JSON object: ${err.message}` };
    }
  }

  if (expectedType === "string") {
    if (helpItem.format === "url") {
      try {
        if (!["http:", "https:"].includes(new URL(rawInput).protocol)) throw new Error("protocol");
      } catch { return { ok: false, error: "Expected an HTTP or HTTPS URL" }; }
    }
    if (helpItem.possibleValues && !helpItem.possibleValues.includes(rawInput)) {
      return {
        ok: false,
        error: `Value "${rawInput}" is not one of allowed values: ${helpItem.possibleValues.join(", ")}`,
      };
    }
    return { ok: true, value: rawInput };
  }

  return { ok: true, value: rawInput };
}

/**
 * Get setting value (or all settings if key omitted).
 */
export function getSettingValue(
  extensionName: string,
  key?: string,
  rootDir = findProjectRoot()
): any {
  const settings = loadSettings(extensionName, rootDir);
  if (!key) {
    return settings;
  }
  return settings[key];
}

/**
 * Set a setting value with validation against settings.help.json.
 */
export function setSettingValue(
  extensionName: string,
  key: string,
  rawValue: any,
  rootDir = findProjectRoot()
): { key: string; oldValue: any; newValue: any } {
  const help = loadSettingsHelp(extensionName, rootDir);
  const helpItem = help?.settings?.[key];
  if (extensionName === "root" && key.includes("API_KEY"))
    throw new Error("API keys belong in .env, not root settings.json");
  if (extensionName === "root" && !helpItem)
    throw new Error(`Unknown root setting "${key}"`);

  let parsedValue: any;
  if (typeof rawValue === "string") {
    const result = parseAndValidateValue(rawValue, helpItem);
    if (!result.ok) {
      throw new Error(`Validation failed for "${key}": ${result.error}`);
    }
    parsedValue = result.value;
  } else {
    parsedValue = rawValue;
    if (extensionName === "root" && helpItem) {
      if (typeof rawValue !== helpItem.type)
        throw new Error(`Validation failed for "${key}": Expected ${helpItem.type}`);
      const result = parseAndValidateValue(String(rawValue), helpItem);
      if (!result.ok) throw new Error(`Validation failed for "${key}": ${result.error}`);
      parsedValue = result.value;
    }
  }

  const current = loadSettings(extensionName, rootDir);
  const oldValue = current[key];
  if (extensionName === "root" && key === "OPENAI_CHAT_ENDPOINT") {
    modelEndpointUrl(parsedValue, parsedValue);
  }
  current[key] = parsedValue;

  saveSettings(extensionName, current, rootDir);
  return { key, oldValue, newValue: parsedValue };
}

/**
 * Describe setting(s) based on settings.help.json.
 */
export function describeSetting(
  extensionName: string,
  key?: string,
  rootDir = findProjectRoot()
): SettingHelpItem | Record<string, SettingHelpItem> | null {
  const help = loadSettingsHelp(extensionName, rootDir);
  if (!help || !help.settings) {
    return null;
  }
  if (key) {
    return help.settings[key] || null;
  }
  return help.settings;
}

/**
 * Reset setting(s) to default value defined in settings.help.json.
 */
export function resetSettingValue(
  extensionName: string,
  key?: string,
  rootDir = findProjectRoot()
): { resetKeys: string[]; settings: Record<string, any> } {
  const help = loadSettingsHelp(extensionName, rootDir);
  if (!help || !help.settings) {
    throw new Error(`No settings.help.json found for extension "${extensionName}" to reset defaults.`);
  }

  const current = loadSettings(extensionName, rootDir);
  const resetKeys: string[] = [];

  if (key) {
    const item = help.settings[key];
    if (!item) {
      throw new Error(`Setting "${key}" not found in help definition for "${extensionName}".`);
    }
    if (item.default !== undefined && item.default !== null) {
      current[key] = item.default;
    } else {
      delete current[key];
    }
    resetKeys.push(key);
  } else {
    for (const [k, item] of Object.entries(help.settings)) {
      if (item.default !== undefined && item.default !== null) {
        current[k] = item.default;
      } else {
        delete current[k];
      }
      resetKeys.push(k);
    }
  }

  saveSettings(extensionName, current, rootDir);
  return { resetKeys, settings: current };
}
