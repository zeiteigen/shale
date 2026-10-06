import { describe, expect, it, afterEach } from "bun:test";
import {
  listCrons,
  findMatchingCrons,
  triggerCron,
  triggerAllCrons,
  handleCliCommand,
  startCli,
  buildCandidates,
  getBestCommandSuggestion,
  getCompleterMatches,
  parseCommandLine,
} from "../main/cli";
import type { CronExtension } from "../lib/extension";
import { SettingsManager } from "../sdk/settings";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

const mockCrons: CronExtension[] = [
  {
    name: "db-backup-cron",
    schedule: "0 2 * * *",
    script: "/path/to/db-backup/index.ts",
    extensionId: "db-backup",
    namespace: "db-backup",
  },
  {
    name: "browser-session-aggregator",
    schedule: "0 */6 * * *",
    script: "/path/to/browser/index.ts",
    extensionId: "browser",
    namespace: "browser",
    run_on_startup: true,
  },
  {
    name: "obsidian-parser-cron",
    schedule: "0 0 * * *",
    script: "/path/to/obsidian/index.ts",
    extensionId: "obsidian parser",
    namespace: "obsidian",
  },
];

describe("Main Process CLI & Manual Cron Triggering", () => {
  describe("listCrons", () => {
    it("formats registered crons into a readable listing", () => {
      const output = listCrons(mockCrons);
      expect(output).toContain("Registered Cron Jobs (3):");
      expect(output).toContain("db-backup-cron");
      expect(output).toContain("browser-session-aggregator [run_on_startup]");
      expect(output).toContain("obsidian-parser-cron");
      expect(output).toContain("0 2 * * *");
    });

    it("handles empty cron list gracefully", () => {
      const output = listCrons([]);
      expect(output).toBe("No registered cron jobs found.");
    });
  });

  describe("findMatchingCrons", () => {
    it("matches exact cron name", () => {
      const matches = findMatchingCrons("db-backup-cron", mockCrons);
      expect(matches.length).toBe(1);
      expect(matches[0].name).toBe("db-backup-cron");
    });

    it("matches exact extensionId", () => {
      const matches = findMatchingCrons("browser", mockCrons);
      expect(matches.length).toBe(1);
      expect(matches[0].name).toBe("browser-session-aggregator");
    });

    it("matches exact namespace", () => {
      const matches = findMatchingCrons("obsidian", mockCrons);
      expect(matches.length).toBe(1);
      expect(matches[0].name).toBe("obsidian-parser-cron");
    });

    it("matches partial name or extension substring", () => {
      const matches = findMatchingCrons("backup", mockCrons);
      expect(matches.length).toBe(1);
      expect(matches[0].name).toBe("db-backup-cron");
    });

    it("handles quotes around query string", () => {
      const matches = findMatchingCrons('"db-backup-cron"', mockCrons);
      expect(matches.length).toBe(1);
      expect(matches[0].name).toBe("db-backup-cron");
    });

    it("returns all crons when query is 'all' or '--all'", () => {
      const matches = findMatchingCrons("all", mockCrons);
      expect(matches.length).toBe(3);

      const matchesFlag = findMatchingCrons("--all", mockCrons);
      expect(matchesFlag.length).toBe(3);
    });

    it("returns empty array when no crons match", () => {
      const matches = findMatchingCrons("non-existent-cron", mockCrons);
      expect(matches.length).toBe(0);
    });
  });

  describe("triggerCron", () => {
    it("successfully triggers a specific matched cron", async () => {
      const triggered: CronExtension[] = [];
      const mockRunCron = async (cron: CronExtension) => {
        triggered.push(cron);
      };

      const result = await triggerCron("db-backup-cron", {
        cronList: mockCrons,
        runCronFn: mockRunCron,
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Cron "db-backup-cron" completed successfully');
      expect(triggered[0]?.name).toBe("db-backup-cron");
    });

    it("returns error message when cron is not found", async () => {
      const result = await triggerCron("unknown-job", {
        cronList: mockCrons,
        runCronFn: async () => {},
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('No cron job matching "unknown-job"');
      expect(result.message).toContain("db-backup-cron");
    });

    it("returns error message when query is ambiguous", async () => {
      const result = await triggerCron("cron", {
        cronList: mockCrons,
        runCronFn: async () => {},
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Ambiguous query "cron"');
      expect(result.message).toContain("db-backup-cron");
      expect(result.message).toContain("obsidian-parser-cron");
    });

    it("catches runCron errors gracefully without throwing", async () => {
      const failingRunCron = async () => {
        throw new Error("Simulated cron execution failure");
      };

      const result = await triggerCron("browser", {
        cronList: mockCrons,
        runCronFn: failingRunCron,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("Simulated cron execution failure");
    });
  });

  describe("triggerAllCrons", () => {
    it("runs all crons and reports completion", async () => {
      let called = false;
      const mockRunAll = async () => {
        called = true;
      };

      const result = await triggerAllCrons({
        cronList: mockCrons,
        runAllCronsFn: mockRunAll,
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("All cron jobs executed in");
      expect(called).toBe(true);
    });

    it("handles failure in runAllCronsFn", async () => {
      const failingRunAll = async () => {
        throw new Error("All crons execution failed");
      };

      const result = await triggerAllCrons({
        cronList: mockCrons,
        runAllCronsFn: failingRunAll,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("All crons execution failed");
    });
  });

  describe("parseCommandLine", () => {
    it("parses unquoted arguments correctly", () => {
      expect(parseCommandLine("cron run db-backup-cron")).toEqual([
        "cron",
        "run",
        "db-backup-cron",
      ]);
    });

    it("handles double and single quotes preserving embedded spaces", () => {
      expect(parseCommandLine('settings set obsidian prompt "Hello World"')).toEqual([
        "settings",
        "set",
        "obsidian",
        "prompt",
        "Hello World",
      ]);
      expect(parseCommandLine("settings set ext key 'single quoted'")).toEqual([
        "settings",
        "set",
        "ext",
        "key",
        "single quoted",
      ]);
    });

    it("handles empty or whitespace-only lines", () => {
      expect(parseCommandLine("")).toEqual([]);
      expect(parseCommandLine("   ")).toEqual([]);
    });
  });

  describe("handleCliCommand", () => {
    it("returns empty output on blank input", async () => {
      const res = await handleCliCommand("   ", { crons: mockCrons });
      expect(res.output).toBe("");
    });

    it("returns help text for 'help' and '?'", async () => {
      const resHelp = await handleCliCommand("help", { crons: mockCrons });
      expect(resHelp.output).toContain("Available CLI Commands:");
      expect(resHelp.output).toContain("cron run <name>");
      expect(resHelp.output).toContain("cron list");
      expect(resHelp.output).toContain("settings list <extension>");

      const resQ = await handleCliCommand("?", { crons: mockCrons });
      expect(resQ.output).toContain("Available CLI Commands:");
    });

    it("returns daemon status for 'status'", async () => {
      const res = await handleCliCommand("status", { crons: mockCrons });
      expect(res.output).toContain("Shale Host Daemon Status:");
      expect(res.output).toContain("Status:            Running");
      expect(res.output).toContain("HTTP Port:");
    });

    it("lists crons via 'cron list', 'crons', and 'list-crons'", async () => {
      const res1 = await handleCliCommand("cron list", { crons: mockCrons });
      expect(res1.output).toContain("Registered Cron Jobs (3):");

      const res2 = await handleCliCommand("crons", { crons: mockCrons });
      expect(res2.output).toContain("Registered Cron Jobs (3):");

      const res3 = await handleCliCommand("list-crons", { crons: mockCrons });
      expect(res3.output).toContain("Registered Cron Jobs (3):");
    });

    it("runs specific cron via 'cron run <name>'", async () => {
      let triggeredName = "";
      const res = await handleCliCommand("cron run db-backup-cron", {
        crons: mockCrons,
        runCronFn: async (c) => {
          triggeredName = c.name!;
        },
      });

      expect(res.success).toBe(true);
      expect(res.output).toContain('Cron "db-backup-cron" completed successfully');
      expect(triggeredName).toBe("db-backup-cron");
    });

    it("runs specific cron via aliases 'run <name>', 'trigger <name>', 'cron <name>'", async () => {
      let runCount = 0;
      const opts = {
        crons: mockCrons,
        runCronFn: async () => {
          runCount++;
        },
      };

      const r1 = await handleCliCommand("run browser", opts);
      expect(r1.success).toBe(true);

      const r2 = await handleCliCommand("trigger obsidian", opts);
      expect(r2.success).toBe(true);

      const r3 = await handleCliCommand("cron db-backup-cron", opts);
      expect(r3.success).toBe(true);

      expect(runCount).toBe(3);
    });

    it("triggers all crons via 'cron run all' and 'run all'", async () => {
      let allRan = 0;
      const opts = {
        crons: mockCrons,
        runAllCronsFn: async () => {
          allRan++;
        },
      };

      const r1 = await handleCliCommand("cron run all", opts);
      expect(r1.success).toBe(true);
      expect(r1.output).toContain("All cron jobs executed");

      const r2 = await handleCliCommand("run all", opts);
      expect(r2.success).toBe(true);

      expect(allRan).toBe(2);
    });

    it("provides error message when 'cron run' lacks target", async () => {
      const res = await handleCliCommand("cron run", { crons: mockCrons });
      expect(res.success).toBe(false);
      expect(res.output).toContain("Missing cron name");
    });

    it("returns exit flag on 'exit' and 'quit'", async () => {
      const r1 = await handleCliCommand("exit", { crons: mockCrons });
      expect(r1.exit).toBe(true);

      const r2 = await handleCliCommand("quit", { crons: mockCrons });
      expect(r2.exit).toBe(true);
    });

    it("handles unknown commands with informative error", async () => {
      const res = await handleCliCommand("foobar baz", { crons: mockCrons });
      expect(res.success).toBe(false);
      expect(res.output).toContain('Unknown command: "foobar baz"');
      expect(res.output).toContain('Type "help"');
    });
  });

  describe("Migrated Settings Commands in Interactive CLI", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
      for (const d of tempDirs) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {}
      }
    });

    function setupMockExtensionEnv() {
      const tempDir = mkdtempSync(join(tmpdir(), "shale-cli-settings-"));
      tempDirs.push(tempDir);
      const extDir = join(tempDir, "extensions", "sample-ext");
      mkdirSync(extDir, { recursive: true });

      writeFileSync(
        join(extDir, "manifest.json"),
        JSON.stringify({ name: "sample-ext", description: "Sample test extension" }),
      );
      writeFileSync(
        join(extDir, "settings.json"),
        JSON.stringify({ enabled: true, maxItems: 10, label: "default-label" }),
      );
      writeFileSync(
        join(extDir, "settings.help.json"),
        JSON.stringify({
          extension: "sample-ext",
          settings: {
            enabled: { type: "boolean", description: "Whether enabled", default: true },
            maxItems: {
              type: "number",
              description: "Maximum item threshold",
              default: 10,
              range: { min: 1, max: 100 },
            },
            label: { type: "string", description: "Custom label", default: "default-label" },
          },
        }),
      );

      return { tempDir, extDir };
    }

    it("shows settings help when typing 'settings' or 'settings help'", async () => {
      const r1 = await handleCliCommand("settings");
      expect(r1.output).toContain("Settings Commands (use root for project settings.json):");
      expect(r1.output).toContain("settings list-extensions");
      expect(r1.output).toContain("settings set <extension> <key> <val>");

      const r2 = await handleCliCommand("settings help");
      expect(r2.output).toContain("Settings Commands (use root for project settings.json):");
    });

    it("lists discovered extensions via 'settings list-extensions' and 'settings extensions'", async () => {
      const { tempDir } = setupMockExtensionEnv();
      const res = await handleCliCommand("settings list-extensions", { rootDir: tempDir });
      expect(res.success).toBe(true);
      expect(stripAnsi(res.output)).toContain("Discovered 1 extension(s):");
      expect(stripAnsi(res.output)).toContain("sample-ext");
      expect(stripAnsi(res.output)).toContain("settings.json, settings.help.json");
    });

    it("lists settings for an extension via 'settings list <ext>'", async () => {
      const { tempDir } = setupMockExtensionEnv();
      const res = await handleCliCommand("settings list sample-ext", { rootDir: tempDir });
      expect(res.success).toBe(true);
      expect(stripAnsi(res.output)).toContain("Settings for sample-ext:");
      expect(stripAnsi(res.output)).toContain("enabled: true");
      expect(stripAnsi(res.output)).toContain("maxItems: 10");
    });

    it("retrieves a setting value or all settings via 'settings get <ext> [key]'", async () => {
      const { tempDir } = setupMockExtensionEnv();

      const rSingle = await handleCliCommand("settings get sample-ext enabled", {
        rootDir: tempDir,
      });
      expect(rSingle.success).toBe(true);
      expect(rSingle.output).toBe("true");

      const rAll = await handleCliCommand("settings get sample-ext", { rootDir: tempDir });
      expect(rAll.success).toBe(true);
      expect(rAll.output).toContain('"maxItems": 10');

      const rMissing = await handleCliCommand("settings get sample-ext nonExistentKey", {
        rootDir: tempDir,
      });
      expect(rMissing.success).toBe(false);
      expect(rMissing.output).toContain('Setting "nonExistentKey" not found');
    });

    it("updates setting with schema validation via 'settings set <ext> <key> <value>'", async () => {
      const { tempDir } = setupMockExtensionEnv();

      // Valid number
      const rNum = await handleCliCommand("settings set sample-ext maxItems 50", {
        rootDir: tempDir,
      });
      expect(rNum.success).toBe(true);
      expect(stripAnsi(rNum.output)).toContain("Updated sample-ext.maxItems = 50");

      // Number out of range
      const rInvalidNum = await handleCliCommand("settings set sample-ext maxItems 500", {
        rootDir: tempDir,
      });
      expect(rInvalidNum.success).toBe(false);
      expect(rInvalidNum.output).toContain("exceeds maximum 100");

      // Valid boolean
      const rBool = await handleCliCommand("settings set sample-ext enabled false", {
        rootDir: tempDir,
      });
      expect(rBool.success).toBe(true);
      expect(stripAnsi(rBool.output)).toContain("Updated sample-ext.enabled = false");

      // Invalid boolean
      const rInvalidBool = await handleCliCommand("settings set sample-ext enabled notabool", {
        rootDir: tempDir,
      });
      expect(rInvalidBool.success).toBe(false);
      expect(rInvalidBool.output).toContain("Expected boolean");
    });

    it("describes setting specifications via 'settings describe <ext> [key]'", async () => {
      const { tempDir } = setupMockExtensionEnv();

      const rSingle = await handleCliCommand("settings describe sample-ext maxItems", {
        rootDir: tempDir,
      });
      expect(rSingle.success).toBe(true);
      expect(stripAnsi(rSingle.output)).toContain("sample-ext.maxItems");
      expect(stripAnsi(rSingle.output)).toContain("Type:        number");
      expect(stripAnsi(rSingle.output)).toContain("Range:       min=1, max=100");

      const rAll = await handleCliCommand("settings describe sample-ext", { rootDir: tempDir });
      expect(rAll.success).toBe(true);
      expect(stripAnsi(rAll.output)).toContain("Settings for sample-ext:");
      expect(stripAnsi(rAll.output)).toContain("enabled (boolean)");
      expect(stripAnsi(rAll.output)).toContain("maxItems (number)");
    });

    it("resets settings to defaults via 'settings reset <ext> [key]'", async () => {
      const { tempDir } = setupMockExtensionEnv();

      // First change value
      await handleCliCommand("settings set sample-ext maxItems 45", { rootDir: tempDir });
      let valRes = await handleCliCommand("settings get sample-ext maxItems", {
        rootDir: tempDir,
      });
      expect(valRes.output).toBe("45");

      // Reset specific key
      const rReset = await handleCliCommand("settings reset sample-ext maxItems", {
        rootDir: tempDir,
      });
      expect(rReset.success).toBe(true);
      expect(stripAnsi(rReset.output)).toContain("Successfully reset 1 setting(s)");

      valRes = await handleCliCommand("settings get sample-ext maxItems", { rootDir: tempDir });
      expect(valRes.output).toBe("10");
    });

    it("verifies settings.json is read on the fly by SettingsManager after CLI update", async () => {
      const { tempDir, extDir } = setupMockExtensionEnv();

      // Instantiate SettingsManager before CLI modification
      const manager = new SettingsManager(extDir);

      // Verify initial values
      expect(manager.get<number>("maxItems")).toBe(10);
      expect(manager.get<boolean>("enabled")).toBe(true);

      // Execute CLI modification command
      const cliResult = await handleCliCommand("settings set sample-ext maxItems 77", {
        rootDir: tempDir,
      });
      expect(cliResult.success).toBe(true);

      // Immediately query manager without restart or re-initialization
      expect(manager.get<number>("maxItems")).toBe(77);
      expect(manager.getAll().maxItems).toBe(77);

      // Modify another setting via CLI
      await handleCliCommand("settings set sample-ext enabled false", { rootDir: tempDir });
      expect(manager.get<boolean>("enabled")).toBe(false);
      expect(manager.getAll().enabled).toBe(false);
    });
  });

  describe("Command Suggestions & Tab Autocompletion Engine", () => {
    it("suggests top-level commands matching typed prefixes", () => {
      const suggestionCr = getBestCommandSuggestion("cr", { crons: mockCrons });
      expect(suggestionCr).toBe("cron list");

      const suggestionStat = getBestCommandSuggestion("stat", { crons: mockCrons });
      expect(suggestionStat).toBe("status");

      const suggestionSett = getBestCommandSuggestion("sett", { crons: mockCrons });
      expect(suggestionSett).toBe("settings");
    });

    it("suggests registered crons when typing 'cron run '", () => {
      const suggestion = getBestCommandSuggestion("cron run db", { crons: mockCrons });
      expect(suggestion).toBe("cron run db-backup-cron");

      const suggestionBrowser = getBestCommandSuggestion("run br", { crons: mockCrons });
      expect(suggestionBrowser).toBe("run browser-session-aggregator");
    });

    it("suggests settings subcommands and extensions", () => {
      const suggestionList = getBestCommandSuggestion("settings li");
      expect(suggestionList).toBe("settings list");

      const suggestionGet = getBestCommandSuggestion("settings get obs");
      expect(suggestionGet).toBe("settings get obsidian");
    });

    it("returns null for empty or non-matching inputs", () => {
      expect(getBestCommandSuggestion("")).toBeNull();
      expect(getBestCommandSuggestion("   ")).toBeNull();
      expect(getBestCommandSuggestion("completely-unknown-command-xyz")).toBeNull();
    });

    it("provides completion candidates for readline completer", () => {
      const [matches, hit] = getCompleterMatches("cron r", { crons: mockCrons });
      expect(hit).toBe("cron r");
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.some((m) => m.startsWith("cron run"))).toBe(true);
    });
  });

  describe("startCli interactive I/O stream integration", () => {
    it("processes input stream lines and writes outputs in non-TTY mode", async () => {
      const inputStream = new PassThrough();
      const outputChunks: string[] = [];
      const outputStream = new PassThrough();

      outputStream.on("data", (chunk) => {
        outputChunks.push(chunk.toString());
      });

      let executed = false;
      const rl = startCli({
        input: inputStream,
        output: outputStream,
        crons: mockCrons,
        isTTY: false,
        runCronFn: async (c) => {
          executed = true;
        },
      });

      // Send commands through the stream
      inputStream.write("cron list\n");
      inputStream.write("cron run db-backup-cron\n");

      // Give event loop time to process lines
      await new Promise((resolve) => setTimeout(resolve, 50));

      const combinedOutput = outputChunks.join("");
      expect(combinedOutput).toContain("Registered Cron Jobs (3):");
      expect(combinedOutput).toContain('Cron "db-backup-cron" completed successfully');
      expect(executed).toBe(true);

      rl.close();
    });

    it("renders ghost text suggestions while typing and autocompletes with Tab in TTY mode", async () => {
      const inputStream = new PassThrough();
      const outputChunks: string[] = [];
      const outputStream = new PassThrough();

      outputStream.on("data", (chunk) => {
        outputChunks.push(chunk.toString());
      });

      let cronRan = false;
      const rl = startCli({
        input: inputStream,
        output: outputStream,
        crons: mockCrons,
        isTTY: true,
        runCronFn: async (c) => {
          cronRan = true;
        },
      });

      // Type "cr" then press Tab (\t) then Enter (\r)
      inputStream.write("cr\t\r");

      await new Promise((resolve) => setTimeout(resolve, 60));

      const combinedOutput = outputChunks.join("");
      // Should have shown banner
      expect(combinedOutput).toContain("Shale Host Daemon");
      // Ghost text contains ANSI gray \x1b[90m
      expect(combinedOutput).toContain("\x1b[90m");
      // "cron list" was executed from Tab completion
      expect(combinedOutput).toContain("Registered Cron Jobs (3):");

      rl.close();
    });
  });
});
