#!/usr/bin/env bun
import path from "node:path";
import fs from "node:fs";
import { Command } from "commander";
import * as p from "@clack/prompts";

export interface SettingHelpItem {
  type: "boolean" | "number" | "string" | "string[]" | "array" | "object" | string;
  description: string;
  default?: any;
  possibleValues?: any[];
  range?: { min?: number; max?: number };
  examples?: any[];
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
  return path.join(rootDir, "extensions", extensionName);
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

/**
 * Load settings.json for an extension.
 */
export function loadSettings(extensionName: string, rootDir = findProjectRoot()): Record<string, any> {
  const extDir = getExtensionDir(extensionName, rootDir);
  if (!fs.existsSync(extDir)) {
    throw new Error(`Extension "${extensionName}" not found at ${extDir}`);
  }
  const settingsPath = path.join(extDir, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
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
  const settingsPath = path.join(extDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
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
    return JSON.parse(fs.readFileSync(helpPath, "utf-8")) as SettingsHelp;
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
    if (isNaN(num)) {
      return { ok: false, error: `Expected valid number, received: "${rawInput}"` };
    }
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

  let parsedValue: any;
  if (typeof rawValue === "string") {
    const result = parseAndValidateValue(rawValue, helpItem);
    if (!result.ok) {
      throw new Error(`Validation failed for "${key}": ${result.error}`);
    }
    parsedValue = result.value;
  } else {
    parsedValue = rawValue;
  }

  const current = loadSettings(extensionName, rootDir);
  const oldValue = current[key];
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

/**
 * Build commander CLI program.
 */
export function createCli(rootDir = findProjectRoot()): Command {
  const program = new Command();

  program
    .name("settings")
    .description("CLI & TUI utility to manage Shale extension configurations")
    .version("0.1.0");

  program
    .command("list-extensions")
    .alias("extensions")
    .description("List all available extensions and their settings status")
    .action(() => {
      const exts = discoverExtensions(rootDir);
      if (exts.length === 0) {
        console.log("No extensions found.");
        return;
      }
      console.log(`Discovered ${exts.length} extension(s):\n`);
      for (const ext of exts) {
        const title = ext.manifest?.name || ext.name;
        const flags = [
          ext.hasSettings ? "settings.json" : "no settings.json",
          ext.hasHelp ? "settings.help.json" : "no settings.help.json",
        ].join(", ");
        console.log(`  • \x1b[1m${ext.name}\x1b[0m (${title}) [${flags}]`);
        if (ext.manifest?.description) {
          console.log(`    ${ext.manifest.description}`);
        }
      }
    });

  program
    .command("list <extension>")
    .description("List all current settings for an extension")
    .action((extension: string) => {
      try {
        const settings = loadSettings(extension, rootDir);
        const help = loadSettingsHelp(extension, rootDir);
        const keys = Object.keys(settings);

        if (keys.length === 0) {
          console.log(`No settings configured for "${extension}".`);
          return;
        }

        console.log(`Settings for \x1b[1m${extension}\x1b[0m:\n`);
        for (const key of keys) {
          const val = settings[key];
          const desc = help?.settings?.[key]?.description;
          console.log(`  \x1b[36m${key}\x1b[0m: ${JSON.stringify(val)}`);
          if (desc) {
            console.log(`    \x1b[90m${desc}\x1b[0m`);
          }
        }
      } catch (err: any) {
        console.error(`\x1b[31mError:\x1b[0m ${err.message}`);
        process.exit(1);
      }
    });

  program
    .command("get <extension> [key]")
    .description("Get the value of a specific setting or all settings")
    .action((extension: string, key?: string) => {
      try {
        const val = getSettingValue(extension, key, rootDir);
        if (key && val === undefined) {
          console.error(`Setting "${key}" not found in "${extension}".`);
          process.exit(1);
        }
        if (typeof val === "object" && val !== null) {
          console.log(JSON.stringify(val, null, 2));
        } else {
          console.log(String(val));
        }
      } catch (err: any) {
        console.error(`\x1b[31mError:\x1b[0m ${err.message}`);
        process.exit(1);
      }
    });

  program
    .command("set <extension> <key> <value>")
    .description("Set a setting value with automatic type validation")
    .action((extension: string, key: string, value: string) => {
      try {
        const res = setSettingValue(extension, key, value, rootDir);
        console.log(`\x1b[32m✔\x1b[0m Updated \x1b[1m${extension}\x1b[0m.${res.key} = ${JSON.stringify(res.newValue)}`);
        if (res.oldValue !== undefined) {
          console.log(`  \x1b[90m(previous value: ${JSON.stringify(res.oldValue)})\x1b[0m`);
        }
      } catch (err: any) {
        console.error(`\x1b[31mError:\x1b[0m ${err.message}`);
        process.exit(1);
      }
    });

  program
    .command("describe <extension> [key]")
    .description("Show description and parameter specifications from settings.help.json")
    .action((extension: string, key?: string) => {
      try {
        const help = describeSetting(extension, key, rootDir);
        if (!help) {
          console.log(`No help documentation found for "${extension}"${key ? ` (setting "${key}")` : ""}.`);
          return;
        }

        if (key) {
          const item = help as SettingHelpItem;
          console.log(`\x1b[1m${extension}.${key}\x1b[0m`);
          console.log(`  Type:        \x1b[33m${item.type}\x1b[0m`);
          console.log(`  Description: ${item.description}`);
          if (item.default !== undefined) {
            console.log(`  Default:     ${JSON.stringify(item.default)}`);
          }
          if (item.range) {
            console.log(`  Range:       min=${item.range.min ?? "any"}, max=${item.range.max ?? "any"}`);
          }
          if (item.possibleValues) {
            console.log(`  Allowed:     ${JSON.stringify(item.possibleValues)}`);
          }
          if (item.examples) {
            console.log(`  Examples:    ${JSON.stringify(item.examples)}`);
          }
        } else {
          const items = help as Record<string, SettingHelpItem>;
          console.log(`\x1b[1mSettings for ${extension}:\x1b[0m\n`);
          for (const [k, item] of Object.entries(items)) {
            console.log(`  • \x1b[36m${k}\x1b[0m (\x1b[33m${item.type}\x1b[0m)`);
            console.log(`    ${item.description}`);
            if (item.default !== undefined) {
              console.log(`    \x1b[90mDefault: ${JSON.stringify(item.default)}\x1b[0m`);
            }
          }
        }
      } catch (err: any) {
        console.error(`\x1b[31mError:\x1b[0m ${err.message}`);
        process.exit(1);
      }
    });

  program
    .command("reset <extension> [key]")
    .description("Reset setting(s) to default value from settings.help.json")
    .action((extension: string, key?: string) => {
      try {
        const res = resetSettingValue(extension, key, rootDir);
        console.log(`\x1b[32m✔\x1b[0m Successfully reset ${res.resetKeys.length} setting(s) for "${extension}".`);
      } catch (err: any) {
        console.error(`\x1b[31mError:\x1b[0m ${err.message}`);
        process.exit(1);
      }
    });

  program
    .command("tui [extension]")
    .description("Launch interactive Terminal User Interface (TUI)")
    .action(async (extension?: string) => {
      await runTui(rootDir, extension);
    });

  return program;
}

/**
 * Interactive Terminal User Interface using @clack/prompts.
 */
export async function runTui(rootDir = findProjectRoot(), defaultExtension?: string): Promise<void> {
  p.intro("⚙️  \x1b[1mExtension Settings Manager\x1b[0m");

  const extensions = discoverExtensions(rootDir);
  if (extensions.length === 0) {
    p.cancel("No extensions found in extensions/ directory.");
    return;
  }

  let selectedExtName = defaultExtension;

  if (!selectedExtName || !extensions.some((e) => e.name === selectedExtName)) {
    if (extensions.length === 1) {
      selectedExtName = extensions[0].name;
    } else {
      const extChoice = await p.select({
        message: "Select an extension to configure:",
        options: extensions.map((e) => ({
          value: e.name,
          label: `${e.name} ${e.manifest?.name ? `(${e.manifest.name})` : ""}`,
          hint: e.manifest?.description,
        })),
      });

      if (p.isCancel(extChoice)) {
        p.cancel("Operation cancelled.");
        return;
      }
      selectedExtName = extChoice as string;
    }
  }

  while (true) {
    const action = await p.select({
      message: `Manage \x1b[36m${selectedExtName}\x1b[0m settings:`,
      options: [
        { value: "edit", label: "✏️  Edit a setting" },
        { value: "view", label: "📋 View all current settings" },
        { value: "describe", label: "📖 Describe a setting (help & constraints)" },
        { value: "reset", label: "🔄 Reset a setting to default" },
        ...(extensions.length > 1 ? [{ value: "switch", label: "🔀 Switch extension" }] : []),
        { value: "exit", label: "🚪 Exit" },
      ],
    });

    if (p.isCancel(action) || action === "exit") {
      p.outro("Goodbye!");
      return;
    }

    if (action === "switch") {
      const nextExt = await p.select({
        message: "Select an extension:",
        options: extensions.map((e) => ({
          value: e.name,
          label: `${e.name} ${e.manifest?.name ? `(${e.manifest.name})` : ""}`,
        })),
      });
      if (!p.isCancel(nextExt)) {
        selectedExtName = nextExt as string;
      }
      continue;
    }

    const currentSettings = loadSettings(selectedExtName, rootDir);
    const helpDoc = loadSettingsHelp(selectedExtName, rootDir);

    if (action === "view") {
      const keys = Object.keys(currentSettings);
      if (keys.length === 0) {
        p.log.warn(`No settings configured yet for ${selectedExtName}.`);
      } else {
        const formatted = keys
          .map((k) => `\x1b[36m${k}\x1b[0m: ${JSON.stringify(currentSettings[k])}`)
          .join("\n");
        p.note(formatted, `Current Settings (${selectedExtName})`);
      }
      continue;
    }

    if (action === "describe") {
      if (!helpDoc || !helpDoc.settings) {
        p.log.warn(`No settings.help.json found for ${selectedExtName}.`);
        continue;
      }

      const keys = Object.keys(helpDoc.settings);
      const chosenKey = await p.select({
        message: "Select a setting to describe:",
        options: [
          { value: "__all__", label: "✨ Show all settings summary" },
          ...keys.map((k) => ({
            value: k,
            label: k,
            hint: `type: ${helpDoc.settings[k].type}`,
          })),
        ],
      });

      if (p.isCancel(chosenKey)) continue;

      if (chosenKey === "__all__") {
        const summary = keys
          .map((k) => {
            const item = helpDoc.settings[k];
            return `• \x1b[36m${k}\x1b[0m (${item.type})\n  ${item.description}\n  Default: ${JSON.stringify(item.default)}`;
          })
          .join("\n\n");
        p.note(summary, `All Settings for ${selectedExtName}`);
      } else {
        const item = helpDoc.settings[chosenKey as string];
        const details = [
          `Description: ${item.description}`,
          `Type:        ${item.type}`,
          item.default !== undefined ? `Default:     ${JSON.stringify(item.default)}` : null,
          item.range ? `Range:       min=${item.range.min ?? "any"}, max=${item.range.max ?? "any"}` : null,
          item.possibleValues ? `Allowed:     ${JSON.stringify(item.possibleValues)}` : null,
          item.examples ? `Examples:    ${JSON.stringify(item.examples)}` : null,
          `Current:     ${JSON.stringify(currentSettings[chosenKey as string])}`,
        ]
          .filter(Boolean)
          .join("\n");
        p.note(details, `${selectedExtName}.${String(chosenKey)}`);
      }
      continue;
    }

    if (action === "reset") {
      if (!helpDoc || !helpDoc.settings) {
        p.log.warn(`No settings.help.json found to reset defaults for ${selectedExtName}.`);
        continue;
      }

      const keys = Object.keys(helpDoc.settings);
      const chosenKey = await p.select({
        message: "Select setting to reset:",
        options: [
          { value: "__all__", label: "⚠️ Reset ALL settings to default" },
          ...keys.map((k) => ({
            value: k,
            label: `${k} (default: ${JSON.stringify(helpDoc.settings[k].default)})`,
          })),
        ],
      });

      if (p.isCancel(chosenKey)) continue;

      const confirmReset = await p.confirm({
        message: `Are you sure you want to reset ${chosenKey === "__all__" ? "ALL settings" : String(chosenKey)} to default?`,
      });

      if (p.isCancel(confirmReset) || !confirmReset) {
        p.log.info("Reset cancelled.");
        continue;
      }

      try {
        const res = resetSettingValue(
          selectedExtName,
          chosenKey === "__all__" ? undefined : (chosenKey as string),
          rootDir
        );
        p.log.success(`Reset ${res.resetKeys.length} setting(s) to defaults!`);
      } catch (err: any) {
        p.log.error(`Reset failed: ${err.message}`);
      }
      continue;
    }

    if (action === "edit") {
      // Gather all known keys from both currentSettings and helpDoc
      const allKeys = Array.from(
        new Set([
          ...Object.keys(currentSettings),
          ...(helpDoc?.settings ? Object.keys(helpDoc.settings) : []),
        ])
      ).sort();

      const chosenKey = await p.select({
        message: "Select setting to edit:",
        options: allKeys.map((k) => {
          const val = currentSettings[k];
          const helpItem = helpDoc?.settings?.[k];
          return {
            value: k,
            label: `${k}: ${JSON.stringify(val)}`,
            hint: helpItem?.description ? helpItem.description.slice(0, 50) + "..." : undefined,
          };
        }),
      });

      if (p.isCancel(chosenKey)) continue;

      const keyName = chosenKey as string;
      const helpItem = helpDoc?.settings?.[keyName];
      const currentVal = currentSettings[keyName];

      if (helpItem?.type === "boolean") {
        const valChoice = await p.select({
          message: `Set boolean value for \x1b[36m${keyName}\x1b[0m (current: ${currentVal}):`,
          options: [
            { value: "true", label: "true" },
            { value: "false", label: "false" },
          ],
        });
        if (p.isCancel(valChoice)) continue;
        setSettingValue(selectedExtName, keyName, valChoice === "true", rootDir);
        p.log.success(`Updated ${keyName} to ${String(valChoice)}`);
      } else {
        const inputPrompt = await p.text({
          message: `Enter new value for \x1b[36m${keyName}\x1b[0m:`,
          initialValue:
            currentVal !== undefined
              ? typeof currentVal === "string"
                ? currentVal
                : JSON.stringify(currentVal)
              : "",
          placeholder: helpItem?.examples ? JSON.stringify(helpItem.examples[0]) : undefined,
          validate(value) {
            const res = parseAndValidateValue(value ?? "", helpItem);
            if (!res.ok) {
              return res.error;
            }
          },
        });

        if (p.isCancel(inputPrompt)) continue;

        try {
          const res = setSettingValue(selectedExtName, keyName, inputPrompt, rootDir);
          p.log.success(`Updated ${keyName} = ${JSON.stringify(res.newValue)}`);
        } catch (err: any) {
          p.log.error(err.message);
        }
      }
    }
  }
}

// Direct CLI entrypoint
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    runTui().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else {
    createCli().parse(process.argv);
  }
}
