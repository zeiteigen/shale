import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  discoverExtensions,
  loadSettings,
  saveSettings,
  loadSettingsHelp,
  parseAndValidateValue,
  getSettingValue,
  setSettingValue,
  describeSetting,
  resetSettingValue,
  type SettingHelpItem,
  type SettingsHelp,
} from "../scripts/settings";
import { createExtensionSDK } from "../sdk";

describe("Settings CLI & Management Utilities", () => {
  const tempDirs: string[] = [];

  function createMockProject() {
    const rootDir = mkdtempSync(join(tmpdir(), "shale-cli-test-"));
    tempDirs.push(rootDir);

    writeFileSync(join(rootDir, "package.json"), JSON.stringify({ name: "mock-shale" }));

    const extDir = join(rootDir, "extensions", "test-plugin");
    mkdirSync(extDir, { recursive: true });

    writeFileSync(
      join(extDir, "manifest.json"),
      JSON.stringify({
        name: "test-plugin",
        description: "A test plugin for CLI testing",
      })
    );

    const initialSettings = {
      enabled: true,
      maxItems: 50,
      tags: ["alpha", "beta"],
      theme: "dark",
    };
    writeFileSync(join(extDir, "settings.json"), JSON.stringify(initialSettings, null, 2));

    const helpData: SettingsHelp = {
      extension: "test-plugin",
      settings: {
        enabled: {
          type: "boolean",
          description: "Whether the plugin is enabled.",
          default: true,
          possibleValues: [true, false],
        },
        maxItems: {
          type: "number",
          description: "Maximum number of items to process.",
          default: 50,
          range: { min: 10, max: 200 },
        },
        tags: {
          type: "string[]",
          description: "List of tags.",
          default: ["alpha", "beta"],
        },
        theme: {
          type: "string",
          description: "UI theme name.",
          default: "dark",
          possibleValues: ["dark", "light", "system"],
        },
        customPrompt: {
          type: "string",
          description: "Optional custom prompt template.",
          default: null,
        },
      },
    };
    writeFileSync(join(extDir, "settings.help.json"), JSON.stringify(helpData, null, 2));

    return { rootDir, extDir, helpData };
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  describe("Extension Discovery", () => {
    it("discovers extensions with settings and help metadata", () => {
      const { rootDir } = createMockProject();
      const exts = discoverExtensions(rootDir);

      expect(exts.length).toBe(1);
      expect(exts[0].name).toBe("test-plugin");
      expect(exts[0].hasSettings).toBe(true);
      expect(exts[0].hasHelp).toBe(true);
      expect(exts[0].manifest?.name).toBe("test-plugin");
    });

    it("discovers workspace extensions including obsidian", () => {
      const exts = discoverExtensions();
      const obsidianExt = exts.find((e) => e.name === "obsidian");

      expect(obsidianExt).toBeDefined();
      expect(obsidianExt?.hasSettings).toBe(true);
      expect(obsidianExt?.hasHelp).toBe(true);
    });
  });

  describe("Value Parsing & Validation", () => {
    it("validates and coerces boolean inputs", () => {
      const boolHelp: SettingHelpItem = { type: "boolean", description: "Flag" };

      expect(parseAndValidateValue("true", boolHelp)).toEqual({ ok: true, value: true });
      expect(parseAndValidateValue("TRUE", boolHelp)).toEqual({ ok: true, value: true });
      expect(parseAndValidateValue("1", boolHelp)).toEqual({ ok: true, value: true });
      expect(parseAndValidateValue("yes", boolHelp)).toEqual({ ok: true, value: true });

      expect(parseAndValidateValue("false", boolHelp)).toEqual({ ok: true, value: false });
      expect(parseAndValidateValue("FALSE", boolHelp)).toEqual({ ok: true, value: false });
      expect(parseAndValidateValue("0", boolHelp)).toEqual({ ok: true, value: false });
      expect(parseAndValidateValue("no", boolHelp)).toEqual({ ok: true, value: false });

      const invalid = parseAndValidateValue("maybe", boolHelp);
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) {
        expect(invalid.error).toContain("Expected boolean");
      }
    });

    it("validates and coerces number inputs with min/max bounds", () => {
      const numHelp: SettingHelpItem = {
        type: "number",
        description: "Port",
        range: { min: 1000, max: 9000 },
      };

      expect(parseAndValidateValue("3000", numHelp)).toEqual({ ok: true, value: 3000 });

      const belowMin = parseAndValidateValue("500", numHelp);
      expect(belowMin.ok).toBe(false);
      if (!belowMin.ok) {
        expect(belowMin.error).toContain("below minimum 1000");
      }

      const aboveMax = parseAndValidateValue("9500", numHelp);
      expect(aboveMax.ok).toBe(false);
      if (!aboveMax.ok) {
        expect(aboveMax.error).toContain("exceeds maximum 9000");
      }

      const notNum = parseAndValidateValue("abc", numHelp);
      expect(notNum.ok).toBe(false);
      if (!notNum.ok) {
        expect(notNum.error).toContain("Expected valid number");
      }
    });

    it("validates string arrays in JSON or comma-separated formats", () => {
      const arrHelp: SettingHelpItem = { type: "string[]", description: "Extensions" };

      expect(parseAndValidateValue('["md", "txt"]', arrHelp)).toEqual({
        ok: true,
        value: ["md", "txt"],
      });

      expect(parseAndValidateValue("md, txt, json", arrHelp)).toEqual({
        ok: true,
        value: ["md", "txt", "json"],
      });
    });

    it("enforces allowed possible values", () => {
      const themeHelp: SettingHelpItem = {
        type: "string",
        description: "Theme",
        possibleValues: ["light", "dark"],
      };

      expect(parseAndValidateValue("dark", themeHelp)).toEqual({ ok: true, value: "dark" });

      const invalid = parseAndValidateValue("solarized", themeHelp);
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) {
        expect(invalid.error).toContain("not one of allowed values");
      }
    });
  });

  describe("CRUD Operations (get, set, describe, reset)", () => {
    it("reads setting values and loads help descriptions", () => {
      const { rootDir } = createMockProject();

      expect(getSettingValue("test-plugin", "enabled", rootDir)).toBe(true);
      expect(getSettingValue("test-plugin", "maxItems", rootDir)).toBe(50);
      expect(getSettingValue("test-plugin", undefined, rootDir)).toEqual({
        enabled: true,
        maxItems: 50,
        tags: ["alpha", "beta"],
        theme: "dark",
      });

      const desc = describeSetting("test-plugin", "maxItems", rootDir) as SettingHelpItem;
      expect(desc.description).toContain("Maximum number of items");
      expect(desc.range?.min).toBe(10);
    });

    it("modifies setting values and saves them to disk", () => {
      const { rootDir } = createMockProject();

      const res = setSettingValue("test-plugin", "maxItems", "120", rootDir);
      expect(res.oldValue).toBe(50);
      expect(res.newValue).toBe(120);

      const updated = loadSettings("test-plugin", rootDir);
      expect(updated.maxItems).toBe(120);
    });

    it("throws error when attempting to set invalid value", () => {
      const { rootDir } = createMockProject();

      expect(() => {
        setSettingValue("test-plugin", "maxItems", "9999", rootDir);
      }).toThrow("Validation failed for \"maxItems\"");
    });

    it("resets individual setting to default value", () => {
      const { rootDir } = createMockProject();

      setSettingValue("test-plugin", "maxItems", "100", rootDir);
      expect(loadSettings("test-plugin", rootDir).maxItems).toBe(100);

      const res = resetSettingValue("test-plugin", "maxItems", rootDir);
      expect(res.resetKeys).toEqual(["maxItems"]);
      expect(res.settings.maxItems).toBe(50); // Default is 50
    });

    it("resets all settings to their defaults", () => {
      const { rootDir } = createMockProject();

      setSettingValue("test-plugin", "maxItems", "150", rootDir);
      setSettingValue("test-plugin", "theme", "light", rootDir);

      const res = resetSettingValue("test-plugin", undefined, rootDir);
      expect(res.resetKeys.length).toBeGreaterThan(0);
      expect(res.settings.maxItems).toBe(50);
      expect(res.settings.theme).toBe("dark");
    });
  });

  describe("Real-Time SDK Hot-Reload Integration", () => {
    it("reflects CLI setting updates immediately in ShaleSDK without restart", () => {
      const { rootDir, extDir } = createMockProject();

      const sdk = createExtensionSDK("test-plugin", { namespace: "test-plugin", extensionName: "test-plugin", extensionDir: extDir });

      // Initial read through SDK
      expect(sdk.settings.get<number>("maxItems")).toBe(50);
      expect(sdk.settings.get<string>("theme")).toBe("dark");

      // Update via CLI set function
      setSettingValue("test-plugin", "maxItems", "180", rootDir);
      setSettingValue("test-plugin", "theme", "light", rootDir);

      // Immediate subsequent read through SDK without recreating or restarting SDK
      expect(sdk.settings.get<number>("maxItems")).toBe(180);
      expect(sdk.settings.get<string>("theme")).toBe("light");
      expect(sdk.settings.getAll().maxItems).toBe(180);
    });
  });

  describe("CLI Command Line Execution", () => {
    it("executes CLI commands via process invocation", () => {
      // 1. Test help
      const helpProc = spawnSync("bun", ["scripts/settings.ts", "--help"], {
        encoding: "utf-8",
      });
      expect(helpProc.status).toBe(0);
      expect(helpProc.stdout).toContain("CLI & TUI utility");

      // 2. Test list-extensions
      const listProc = spawnSync("bun", ["scripts/settings.ts", "list-extensions"], {
        encoding: "utf-8",
      });
      expect(listProc.status).toBe(0);
      expect(listProc.stdout).toContain("obsidian");

      // 3. Test get
      const getProc = spawnSync("bun", ["scripts/settings.ts", "get", "obsidian", "includeMarkdown"], {
        encoding: "utf-8",
      });
      expect(getProc.status).toBe(0);
      expect(getProc.stdout.trim()).toBe("true");

      // 4. Test describe
      const descProc = spawnSync("bun", ["scripts/settings.ts", "describe", "obsidian", "atomicNoteCharLimit"], {
        encoding: "utf-8",
      });
      expect(descProc.status).toBe(0);
      expect(descProc.stdout).toContain("Maximum character length");
      expect(descProc.stdout).toContain("number");

      // 5. Test set with validation failure
      const failProc = spawnSync("bun", ["scripts/settings.ts", "set", "obsidian", "atomicNoteCharLimit", "-5"], {
        encoding: "utf-8",
      });
      expect(failProc.status).not.toBe(0);
      expect(failProc.stderr).toContain("below minimum 50");
    });
  });
});
