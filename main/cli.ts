import { getRootSetting } from "../lib/settings";
import * as readline from "node:readline";
import { crons as loadedCrons, extensionNamespaces } from "./load-extensions";
import { runCron as defaultRunCron, runAllCrons as defaultRunAllCrons } from "./index";
import type { CronExtension } from "../lib/extension";
import {
  discoverExtensions,
  discoverSettingsTargets,
  loadSettings,
  saveSettings,
  loadSettingsHelp,
  getSettingValue,
  setSettingValue,
  describeSetting,
  resetSettingValue,
  runTui,
  findProjectRoot,
  type ExtensionInfo,
  type SettingsHelp,
  type SettingHelpItem,
} from "../scripts/settings";

export interface CliOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  crons?: CronExtension[];
  runCronFn?: (cron: CronExtension) => Promise<void>;
  runAllCronsFn?: () => Promise<void>;
  prompt?: string;
  isTTY?: boolean;
  rootDir?: string;
}

export interface CliCommandResult {
  output: string;
  success?: boolean;
  exit?: boolean;
  cron?: CronExtension;
}

/**
 * Parses a command line string into arguments, supporting double and single quotes.
 */
export function parseCommandLine(line: string): string[] {
  const args: string[] = [];
  const trimmed = line.trim();
  if (!trimmed) return args;

  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(trimmed)) !== null) {
    if (match[1] !== undefined) {
      args.push(match[1]);
    } else if (match[2] !== undefined) {
      args.push(match[2]);
    } else {
      args.push(match[0]);
    }
  }
  return args;
}

/**
 * Formats all registered cron jobs into a human-readable list.
 */
export function listCrons(cronList: CronExtension[] = loadedCrons): string {
  if (!cronList || cronList.length === 0) {
    return "No registered cron jobs found.";
  }

  const lines: string[] = [`Registered Cron Jobs (${cronList.length}):`];
  cronList.forEach((cron, idx) => {
    const name = cron.name || "unnamed";
    const ext = cron.extensionId || "default";
    const startup = cron.run_on_startup ? " [run_on_startup]" : "";
    lines.push(`  ${idx + 1}. ${name}${startup}`);
    lines.push(`     Extension: ${ext}`);
    lines.push(`     Schedule:  ${cron.schedule}`);
    lines.push(`     Script:    ${cron.script}`);
  });
  return lines.join("\n");
}

/**
 * Searches for cron jobs matching the query by name, extension ID, namespace, or script path.
 */
export function findMatchingCrons(
  query: string,
  cronList: CronExtension[] = loadedCrons,
): CronExtension[] {
  const q = query.trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (!q) return [];

  if (q === "all" || q === "--all") {
    return [...cronList];
  }

  // 1. Exact match by cron name
  const exactName = cronList.filter(
    (c) => (c.name || "").toLowerCase() === q,
  );
  if (exactName.length === 1) return exactName;

  // 2. Exact match by extensionId
  const exactExt = cronList.filter(
    (c) => (c.extensionId || "").toLowerCase() === q,
  );
  if (exactExt.length === 1) return exactExt;

  // 3. Exact match by namespace
  const exactNs = cronList.filter(
    (c) => (c.namespace || "").toLowerCase() === q,
  );
  if (exactNs.length === 1) return exactNs;

  // 4. Substring / partial match on name, extensionId, namespace, or script basename
  const partialMatches = cronList.filter((c) => {
    const name = (c.name || "").toLowerCase();
    const ext = (c.extensionId || "").toLowerCase();
    const ns = (c.namespace || "").toLowerCase();
    const script = (c.script || "").toLowerCase();
    return name.includes(q) || ext.includes(q) || ns.includes(q) || script.includes(q);
  });

  return partialMatches;
}

/**
 * Manually triggers a specific cron job matched by query string.
 */
export async function triggerCron(
  query: string,
  options?: {
    cronList?: CronExtension[];
    runCronFn?: (cron: CronExtension) => Promise<void>;
  },
): Promise<{ success: boolean; message: string; cron?: CronExtension }> {
  const cronList = options?.cronList ?? loadedCrons;
  const runCronFn = options?.runCronFn ?? defaultRunCron;

  const matches = findMatchingCrons(query, cronList);

  if (matches.length === 0) {
    const available = cronList
      .map((c) => `  - ${c.name || c.extensionId} (${c.extensionId || "default"})`)
      .join("\n");
    return {
      success: false,
      message: `No cron job matching "${query}".\nAvailable cron jobs:\n${available || "  (none)"}`,
    };
  }

  if (matches.length > 1) {
    const matchedList = matches
      .map((c) => `  - ${c.name || c.extensionId} (${c.extensionId || "default"})`)
      .join("\n");
    return {
      success: false,
      message: `Ambiguous query "${query}" matches multiple cron jobs:\n${matchedList}\nPlease specify the exact cron name.`,
    };
  }

  const cron = matches[0];
  const displayName = cron.name || cron.extensionId || "unnamed";
  console.log(`[CLI] Manually triggering cron "${displayName}" (${cron.script})...`);
  const start = performance.now();
  try {
    await runCronFn(cron);
    const elapsed = ((performance.now() - start) / 1000).toFixed(2);
    const msg = `[CLI] Cron "${displayName}" completed successfully in ${elapsed}s.`;
    return { success: true, message: msg, cron };
  } catch (err: any) {
    const elapsed = ((performance.now() - start) / 1000).toFixed(2);
    const msg = `[CLI] Cron "${displayName}" failed after ${elapsed}s: ${err?.message || err}`;
    return { success: false, message: msg, cron };
  }
}

/**
 * Manually triggers all registered cron jobs sequentially.
 */
export async function triggerAllCrons(options?: {
  cronList?: CronExtension[];
  runAllCronsFn?: () => Promise<void>;
}): Promise<{ success: boolean; message: string }> {
  const runAllFn = options?.runAllCronsFn ?? defaultRunAllCrons;
  console.log(`[CLI] Triggering all registered cron jobs...`);
  const start = performance.now();
  try {
    await runAllFn();
    const elapsed = ((performance.now() - start) / 1000).toFixed(2);
    return {
      success: true,
      message: `[CLI] All cron jobs executed in ${elapsed}s.`,
    };
  } catch (err: any) {
    const elapsed = ((performance.now() - start) / 1000).toFixed(2);
    return {
      success: false,
      message: `[CLI] Failed running all cron jobs after ${elapsed}s: ${err?.message || err}`,
    };
  }
}

/**
 * Builds a dynamic list of command templates for auto-completion and typing suggestions.
 */
export function buildCandidates(options?: CliOptions): string[] {
  const cronList = options?.crons ?? loadedCrons;
  const rootDir = options?.rootDir ?? findProjectRoot();

  const candidates: string[] = [
    "cron list",
    "cron run all",
    "status",
    "help",
    "settings",
    "settings list-extensions",
    "settings list-targets",
    "settings targets",
    "settings help",
    "settings list",
    "settings get",
    "settings set",
    "settings describe",
    "settings reset",
    "crons",
    "list-crons",
    "run all",
    "settings extensions",
    "exit",
    "quit",
  ];

  for (const cron of cronList) {
    if (cron.name) {
      candidates.push(`cron run ${cron.name}`);
      candidates.push(`cron trigger ${cron.name}`);
      candidates.push(`run ${cron.name}`);
      candidates.push(`trigger ${cron.name}`);
    }
  }

  let exts: ExtensionInfo[] = [];
  try {
    exts = discoverSettingsTargets(rootDir);
  } catch {}

  for (const ext of exts) {
    candidates.push(`settings list ${ext.name}`);
    candidates.push(`settings ls ${ext.name}`);
    candidates.push(`settings get ${ext.name}`);
    candidates.push(`settings set ${ext.name}`);
    candidates.push(`settings describe ${ext.name}`);
    candidates.push(`settings reset ${ext.name}`);
    candidates.push(`settings tui ${ext.name}`);

    let help: SettingsHelp | null = null;
    try {
      help = loadSettingsHelp(ext.name, rootDir);
    } catch {}

    const settingKeys = new Set<string>();
    if (help?.settings) {
      for (const k of Object.keys(help.settings)) {
        settingKeys.add(k);
      }
    }
    try {
      const current = loadSettings(ext.name, rootDir);
      for (const k of Object.keys(current)) {
        settingKeys.add(k);
      }
    } catch {}

    for (const key of settingKeys) {
      candidates.push(`settings get ${ext.name} ${key}`);
      candidates.push(`settings describe ${ext.name} ${key}`);
      candidates.push(`settings reset ${ext.name} ${key}`);

      const item = help?.settings?.[key];
      if (item?.type === "boolean") {
        candidates.push(`settings set ${ext.name} ${key} true`);
        candidates.push(`settings set ${ext.name} ${key} false`);
      } else if (item?.possibleValues && Array.isArray(item.possibleValues)) {
        for (const val of item.possibleValues) {
          candidates.push(`settings set ${ext.name} ${key} ${val}`);
        }
      } else if (item?.default !== undefined) {
        candidates.push(`settings set ${ext.name} ${key} ${JSON.stringify(item.default)}`);
      } else {
        candidates.push(`settings set ${ext.name} ${key}`);
      }
    }
  }

  return candidates;
}

/**
 * Returns the single best command suggestion matching the current line prefix.
 */
export function getBestCommandSuggestion(
  line: string,
  options?: CliOptions,
): string | null {
  if (!line || !line.trim()) return null;

  const candidates = buildCandidates(options);
  const matches = candidates.filter((c) => c.startsWith(line) && c !== line);
  if (matches.length === 0) return null;

  const isAlias = (c: string) =>
    c === "crons" || c === "list-crons" || c === "quit" || c.startsWith("settings ls");

  matches.sort((a, b) => {
    const aAlias = isAlias(a) ? 1 : 0;
    const bAlias = isAlias(b) ? 1 : 0;
    if (aAlias !== bAlias) return aAlias - bAlias;

    const aWords = a.trim().split(/\s+/).length;
    const bWords = b.trim().split(/\s+/).length;
    if (aWords !== bWords) return aWords - bWords;

    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  });

  return matches[0];
}

/**
 * Readline completer function providing tab completion candidates.
 */
export function getCompleterMatches(
  line: string,
  options?: CliOptions,
): [string[], string] {
  const candidates = buildCandidates(options);
  const matches = candidates.filter((c) => c.startsWith(line));
  if (matches.length > 0) {
    return [matches, line];
  }
  return [candidates, line];
}

/**
 * Handles all extension settings commands within the CLI.
 */
export async function handleSettingsCliCommand(
  parts: string[],
  rawLine: string,
  options?: CliOptions,
): Promise<CliCommandResult> {
  const rootDir = options?.rootDir ?? findProjectRoot();
  const sub = parts[1]?.toLowerCase();

  // settings help or settings alone
  if (!sub || sub === "help" || sub === "?") {
    return {
      output: [
        "Settings Commands (use root for project settings.json):",
        "  settings list-targets                  List root and extension settings targets",
        "  settings list-extensions               List all available extensions and their settings files",
        "  settings list <extension>              List all current settings for an extension",
        "  settings get <extension> [key]         Get a specific setting value or all settings",
        "  settings set <extension> <key> <val>   Update a setting with schema validation",
        "  settings describe <extension> [key]    Show parameter documentation and constraints",
        "  settings reset <extension> [key]       Reset setting(s) to defaults from settings.help.json",
        "  settings tui [extension]               Launch interactive Terminal User Interface (TUI)",
        "",
        "Shortcuts & Aliases:",
        "  settings extensions                    Alias for \"settings list-extensions\"",
        "  settings ls <extension>                Alias for \"settings list <extension>\"",
      ].join("\n"),
      success: true,
    };
  }

  // settings list-extensions / settings extensions
  if (sub === "list-extensions" || sub === "extensions" || sub === "list-targets" || sub === "targets") {
    try {
      const includeRoot = sub === "list-targets" || sub === "targets";
      const exts = includeRoot ? discoverSettingsTargets(rootDir) : discoverExtensions(rootDir);
      if (exts.length === 0) {
        return { output: "No extensions found.", success: true };
      }
      const lines: string[] = [`Discovered ${exts.length} ${includeRoot ? "settings target(s)" : "extension(s)"}:\n`];
      for (const ext of exts) {
        const title = ext.manifest?.name || ext.name;
        const flags = [
          ext.hasSettings ? "settings.json" : "no settings.json",
          ext.hasHelp ? "settings.help.json" : "no settings.help.json",
        ].join(", ");
        lines.push(`  • \x1b[1m${ext.name}\x1b[0m (${title}) [${flags}]`);
        if (ext.manifest?.description) {
          lines.push(`    ${ext.manifest.description}`);
        }
      }
      return { output: lines.join("\n"), success: true };
    } catch (err: any) {
      return { output: `Error: ${err.message}`, success: false };
    }
  }

  // settings list <extension> / settings ls <extension>
  if (sub === "list" || sub === "ls") {
    const extName = parts[2];
    if (!extName) {
      return {
        output: 'Error: Missing extension name. Usage: "settings list <extension>"',
        success: false,
      };
    }
    try {
      const settings = loadSettings(extName, rootDir);
      const help = loadSettingsHelp(extName, rootDir);
      const keys = Object.keys(settings);

      if (keys.length === 0) {
        return { output: `No settings configured for "${extName}".`, success: true };
      }

      const lines: string[] = [`Settings for \x1b[1m${extName}\x1b[0m:\n`];
      for (const key of keys) {
        const val = settings[key];
        const desc = help?.settings?.[key]?.description;
        lines.push(`  \x1b[36m${key}\x1b[0m: ${JSON.stringify(val)}`);
        if (desc) {
          lines.push(`    \x1b[90m${desc}\x1b[0m`);
        }
      }
      return { output: lines.join("\n"), success: true };
    } catch (err: any) {
      return { output: `Error: ${err.message}`, success: false };
    }
  }

  // settings get <extension> [key]
  if (sub === "get") {
    const extName = parts[2];
    const key = parts[3];
    if (!extName) {
      return {
        output: 'Error: Missing extension name. Usage: "settings get <extension> [key]"',
        success: false,
      };
    }
    try {
      const val = getSettingValue(extName, key, rootDir);
      if (key && val === undefined) {
        return { output: `Error: Setting "${key}" not found in "${extName}".`, success: false };
      }
      let formatted: string;
      if (typeof val === "object" && val !== null) {
        formatted = JSON.stringify(val, null, 2);
      } else {
        formatted = String(val);
      }
      return { output: formatted, success: true };
    } catch (err: any) {
      return { output: `Error: ${err.message}`, success: false };
    }
  }

  // settings set <extension> <key> <value...>
  if (sub === "set") {
    const extName = parts[2];
    const key = parts[3];
    const val = parts.length > 5 ? parts.slice(4).join(" ") : parts[4];
    if (!extName || !key || val === undefined) {
      return {
        output: 'Error: Missing arguments. Usage: "settings set <extension> <key> <value>"',
        success: false,
      };
    }
    try {
      const res = setSettingValue(extName, key, val, rootDir);
      const prevMsg = res.oldValue !== undefined ? ` (previous value: ${JSON.stringify(res.oldValue)})` : "";
      return {
        output: `\x1b[32m✔\x1b[0m Updated \x1b[1m${extName}\x1b[0m.${res.key} = ${JSON.stringify(res.newValue)}${prevMsg}`,
        success: true,
      };
    } catch (err: any) {
      return { output: `Error: ${err.message}`, success: false };
    }
  }

  // settings describe <extension> [key]
  if (sub === "describe") {
    const extName = parts[2];
    const key = parts[3];
    if (!extName) {
      return {
        output: 'Error: Missing extension name. Usage: "settings describe <extension> [key]"',
        success: false,
      };
    }
    try {
      const help = describeSetting(extName, key, rootDir);
      if (!help) {
        return {
          output: `No help documentation found for "${extName}"${key ? ` (setting "${key}")` : ""}.`,
          success: true,
        };
      }

      if (key) {
        const item = help as SettingHelpItem;
        const lines: string[] = [
          `\x1b[1m${extName}.${key}\x1b[0m`,
          `  Type:        \x1b[33m${item.type}\x1b[0m`,
          `  Description: ${item.description}`,
        ];
        if (item.default !== undefined) {
          lines.push(`  Default:     ${JSON.stringify(item.default)}`);
        }
        if (item.range) {
          lines.push(`  Range:       min=${item.range.min ?? "any"}, max=${item.range.max ?? "any"}`);
        }
        if (item.possibleValues) {
          lines.push(`  Allowed:     ${JSON.stringify(item.possibleValues)}`);
        }
        if (item.examples) {
          lines.push(`  Examples:    ${JSON.stringify(item.examples)}`);
        }
        return { output: lines.join("\n"), success: true };
      } else {
        const items = help as Record<string, SettingHelpItem>;
        const lines: string[] = [`\x1b[1mSettings for ${extName}:\x1b[0m\n`];
        for (const [k, item] of Object.entries(items)) {
          lines.push(`  • \x1b[36m${k}\x1b[0m (\x1b[33m${item.type}\x1b[0m)`);
          lines.push(`    ${item.description}`);
          if (item.default !== undefined) {
            lines.push(`    \x1b[90mDefault: ${JSON.stringify(item.default)}\x1b[0m`);
          }
        }
        return { output: lines.join("\n"), success: true };
      }
    } catch (err: any) {
      return { output: `Error: ${err.message}`, success: false };
    }
  }

  // settings reset <extension> [key]
  if (sub === "reset") {
    const extName = parts[2];
    const key = parts[3];
    if (!extName) {
      return {
        output: 'Error: Missing extension name. Usage: "settings reset <extension> [key]"',
        success: false,
      };
    }
    try {
      const res = resetSettingValue(extName, key, rootDir);
      return {
        output: `\x1b[32m✔\x1b[0m Successfully reset ${res.resetKeys.length} setting(s) for "${extName}".`,
        success: true,
      };
    } catch (err: any) {
      return { output: `Error: ${err.message}`, success: false };
    }
  }

  // settings tui [extension]
  if (sub === "tui") {
    if (!options?.isTTY) {
      return { output: "Error: TUI requires an interactive terminal session.", success: false };
    }
    try {
      await runTui(rootDir, parts[2]);
      return { output: "", success: true };
    } catch (err: any) {
      return { output: `Error: ${err.message}`, success: false };
    }
  }

  return {
    output: `Unknown settings subcommand: "${sub}". Type "settings help" for available commands.`,
    success: false,
  };
}

/**
 * Parses and executes a single CLI command string.
 */
export async function handleCliCommand(
  rawInput: string,
  options?: CliOptions,
): Promise<CliCommandResult> {
  const line = rawInput.trim();
  if (!line) {
    return { output: "" };
  }

  const cronList = options?.crons ?? loadedCrons;
  const runCronFn = options?.runCronFn ?? defaultRunCron;
  const runAllCronsFn = options?.runAllCronsFn ?? defaultRunAllCrons;

  const parts = parseCommandLine(line);
  if (parts.length === 0) {
    return { output: "" };
  }

  const root = parts[0].toLowerCase();
  const sub = parts[1]?.toLowerCase();
  const rest = parts.slice(2).join(" ").trim();

  // Exit / Quit
  if (root === "exit" || root === "quit") {
    return { output: "Exiting Shale host daemon...", exit: true, success: true };
  }

  // Help
  if (root === "help" || root === "?") {
    return {
      output: [
        "Available CLI Commands:",
        "  cron list                      List all registered cron jobs",
        "  cron run <name>                Trigger a specific cron job (e.g. \"cron run db-backup-cron\")",
        "  cron run all                   Trigger all registered cron jobs sequentially",
        "  settings list-extensions       List all available extensions and their settings status",
        "  settings list-targets          List root and extension settings targets",
        "  settings list <extension>      List all settings for an extension",
        "  settings get <extension> [key] Get a specific setting value or all settings",
        "  settings set <ext> <key> <val> Update a setting with schema validation",
        "  settings describe <ext> [key]  Show parameter documentation and constraints",
        "  settings reset <ext> [key]     Reset setting(s) to defaults",
        "  settings list root             View root settings.json (root supports get/set/reset/tui)",
        "  status                         Display host daemon status and active extensions",
        "  help, ?                        Show this help message",
        "  exit, quit                     Shutdown the Shale host daemon",
        "",
        "Shortcuts & Aliases:",
        "  crons                          Alias for \"cron list\"",
        "  run <name>                     Alias for \"cron run <name>\"",
        "  trigger <name>                 Alias for \"cron run <name>\"",
        "  settings                       Show extension settings help",
      ].join("\n"),
      success: true,
    };
  }

  // Status
  if (root === "status") {
    const port = getRootSetting("PORT") || "7425";
    const uptimeSec = Math.floor(process.uptime());
    const mem = process.memoryUsage();
    const memMb = (mem.rss / 1024 / 1024).toFixed(1);
    const extList = Array.from(extensionNamespaces.keys()).join(", ") || "(none)";

    return {
      output: [
        "Shale Host Daemon Status:",
        `  Status:            Running`,
        `  HTTP Port:         ${port}`,
        `  Uptime:            ${uptimeSec}s`,
        `  Memory (RSS):      ${memMb} MB`,
        `  Loaded Extensions: ${extensionNamespaces.size} (${extList})`,
        `  Loaded Crons:      ${cronList.length}`,
      ].join("\n"),
      success: true,
    };
  }

  // Settings commands: settings ... or setting ...
  if (root === "settings" || root === "setting") {
    return handleSettingsCliCommand(parts, rawInput, options);
  }

  // cron list / crons / list-crons / list
  if (
    (root === "cron" && (sub === "list" || sub === "ls")) ||
    root === "crons" ||
    root === "list-crons" ||
    (root === "list" && !sub)
  ) {
    return {
      output: listCrons(cronList),
      success: true,
    };
  }

  // cron run all / cron all / run all / run-all-cron
  if (
    (root === "cron" && sub === "run" && (rest === "all" || rest === "--all")) ||
    (root === "cron" && sub === "trigger" && (rest === "all" || rest === "--all")) ||
    (root === "cron" && (sub === "all" || sub === "--all")) ||
    (root === "run" && (sub === "all" || sub === "--all")) ||
    (root === "trigger" && (sub === "all" || sub === "--all")) ||
    root === "run-all-cron"
  ) {
    const res = await triggerAllCrons({ cronList, runAllCronsFn });
    return { output: res.message, success: res.success };
  }

  // cron run <name> / cron trigger <name>
  if (root === "cron" && (sub === "run" || sub === "trigger")) {
    if (!rest) {
      return {
        output: 'Error: Missing cron name. Usage: "cron run <name>". Run "cron list" to see available crons.',
        success: false,
      };
    }
    const res = await triggerCron(rest, { cronList, runCronFn });
    return { output: res.message, success: res.success, cron: res.cron };
  }

  // cron <name> (e.g. "cron db-backup-cron" or "cron obsidian")
  if (root === "cron") {
    const target = parts.slice(1).join(" ").trim();
    if (!target) {
      return {
        output: [
          'Usage of "cron":',
          "  cron list                      List all registered cron jobs",
          "  cron run <name>                Trigger a specific cron job",
          "  cron run all                   Trigger all registered cron jobs",
        ].join("\n"),
        success: false,
      };
    }
    if (target === "all" || target === "--all") {
      const res = await triggerAllCrons({ cronList, runAllCronsFn });
      return { output: res.message, success: res.success };
    }
    const res = await triggerCron(target, { cronList, runCronFn });
    return { output: res.message, success: res.success, cron: res.cron };
  }

  // run <name> / trigger <name> / run-cron <name>
  if (root === "run" || root === "trigger" || root === "run-cron") {
    const target = root === "run-cron" ? parts.slice(1).join(" ").trim() : (sub ? parts.slice(1).join(" ").trim() : "");
    if (!target) {
      return {
        output: `Error: Missing target to ${root}. Usage: "${root} <cron-name>". Run "cron list" to see available crons.`,
        success: false,
      };
    }
    if (target === "all" || target === "--all") {
      const res = await triggerAllCrons({ cronList, runAllCronsFn });
      return { output: res.message, success: res.success };
    }
    const res = await triggerCron(target, { cronList, runCronFn });
    return { output: res.message, success: res.success, cron: res.cron };
  }

  return {
    output: `Unknown command: "${line}". Type "help" for a list of available commands.`,
    success: false,
  };
}

/**
 * Initializes and starts the CLI on the specified or standard I/O streams.
 */
export function startCli(options?: CliOptions): readline.Interface {
  const input = options?.input ?? process.stdin;
  const output = options?.output ?? process.stdout;
  const isTTY = options?.isTTY ?? Boolean((input as any)?.isTTY);
  const prompt = options?.prompt ?? "shale> ";

  const rl = readline.createInterface({
    input,
    output,
    prompt: isTTY ? prompt : "",
    terminal: isTTY,
    completer: (line: string) => {
      return getCompleterMatches(line, options);
    },
  });

  const writeOutput = (text: string) => {
    if (typeof (output as any).write === "function") {
      (output as any).write(text + "\n");
    } else {
      console.log(text);
    }
  };

  if (isTTY) {
    const port = getRootSetting("PORT") || "7425";
    writeOutput("======================================================");
    writeOutput(`  Shale Host Daemon (Port ${port})`);
    writeOutput('  Interactive CLI ready. Type "help", "cron list", or "settings".');
    writeOutput("======================================================");
    rl.prompt();

    // Hook internal _ttyWrite to provide real-time suggestions and tab autocompletion
    const origTtyWrite = (rl as any)._ttyWrite?.bind(rl);
    if (typeof origTtyWrite === "function") {
      (rl as any)._ttyWrite = function (s: any, key: any) {
        // Return / Enter: clear ghost text, then let readline process newline
        if (key && (key.name === "return" || key.name === "enter")) {
          (output as any).write?.("\x1b[0K");
          origTtyWrite(s, key);
          return;
        }

        // Tab or Right Arrow at end of line: autocomplete active suggestion
        if (
          key &&
          (key.name === "tab" || (key.name === "right" && rl.cursor === rl.line.length))
        ) {
          const suggestion = getBestCommandSuggestion(rl.line, options);
          if (suggestion && suggestion.startsWith(rl.line) && suggestion !== rl.line) {
            (output as any).write?.("\x1b[0K");
            const rest = suggestion.slice(rl.line.length);
            rl.write(rest);
            return;
          }
        }

        (output as any).write?.("\x1b[0K");
        origTtyWrite(s, key);

        // After writing key, render ghost suggestion in muted gray if cursor is at end of line
        const currentLine = rl.line;
        if (currentLine && rl.cursor === currentLine.length) {
          const suggestion = getBestCommandSuggestion(currentLine, options);
          if (suggestion && suggestion.startsWith(currentLine) && suggestion !== currentLine) {
            const ghost = suggestion.slice(currentLine.length);
            (output as any).write?.(`\x1b[0K\x1b[90m${ghost}\x1b[0m\x1b[${ghost.length}D`);
            return;
          }
        }
        (output as any).write?.("\x1b[0K");
      };
    }
  }

  let commandQueue: Promise<void> = Promise.resolve();

  rl.on("line", (rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      if (isTTY) rl.prompt();
      return;
    }

    commandQueue = commandQueue.then(async () => {
      try {
        rl.pause();
        const result = await handleCliCommand(line, options);
        if (result.output) {
          writeOutput(result.output);
        }
        if (result.exit) {
          rl.close();
          process.exit(0);
          return;
        }
      } catch (err: any) {
        writeOutput(`[CLI] Unexpected error: ${err?.message || err}`);
      } finally {
        rl.resume();
        if (isTTY) {
          rl.prompt();
        }
      }
    });
  });

  rl.on("SIGINT", () => {
    writeOutput("\n[CLI] Shutting down Shale host daemon...");
    rl.close();
    process.exit(0);
  });

  return rl;
}
