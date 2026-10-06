import type { CronExtension } from "../lib/extension";
import type { CliCommandResult } from "./cli";
import { settingsApi } from "./settings-api";
import { WebLogs } from "./web-logs";
import { WebTasks } from "./web-tasks";
import { getCronRun } from "./cron-runs";

export interface WebContext {
  rootDir: string;
  crons: CronExtension[];
  extensions: Map<string, string>;
  runCron: (cron: CronExtension) => Promise<void>;
  runAllCrons: () => Promise<void>;
  command: (line: string) => Promise<CliCommandResult>;
  shutdown: () => void;
  port: () => number;
  logs: WebLogs;
}

export function createWebApi(context: WebContext) {
  const tasks = new WebTasks();
  return async (req: Request, url: URL): Promise<Response | undefined> => {
    const settings = await settingsApi(req, url, context.rootDir);
    if (settings) return settings;
    if (req.method === "GET" && url.pathname === "/api/host") {
      return Response.json({ status: "running", port: context.port(), uptime: Math.floor(process.uptime()),
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        extensions: [...context.extensions].map(([name, namespace]) => ({ name, namespace })),
        crons: context.crons.map((cron, index) => ({ ...cron, id: String(index), lastRun: getCronRun(cron) })), tasks: tasks.list(),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/logs") return Response.json({ entries: context.logs.list() });
    if (!["/api/crons/run", "/api/command", "/api/shutdown"].includes(url.pathname)) return;
    if (req.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
    try {
      const body = await req.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object.");
      if (url.pathname === "/api/shutdown") {
        if (body.confirm !== true) throw new Error("Confirm shutdown first.");
        setTimeout(context.shutdown, 100);
        return Response.json({ message: "Shutting down Shale." });
      }
      if (tasks.busy) return Response.json({ error: "A manual operation is already running." }, { status: 409 });
      if (url.pathname === "/api/crons/run") {
        const cron = context.crons.find((_, index) => String(index) === body.id);
        if (body.id !== "all" && !cron) throw new Error("Unknown cron job.");
        const label = cron ? cron.name ?? cron.extensionId ?? "Cron job" : "All cron jobs";
        const task = tasks.start(label, async () => {
          if (cron) await context.runCron(cron); else await context.runAllCrons();
          return { success: true, output: `${label} completed.` };
        });
        return Response.json({ task }, { status: 202 });
      }
      if (typeof body.command !== "string" || !body.command.trim() || body.command.length > 8192) throw new Error("Provide a command (up to 8192 characters).");
      const command = body.command.trim();
      if (/^(exit|quit)\b/i.test(command)) throw new Error("Use the Stop host button to confirm shutdown.");
      if (/^settings?\s+tui\b/i.test(command)) throw new Error("Open Settings to edit configuration in the browser.");
      return Response.json({ task: tasks.start(command, () => context.command(command)) }, { status: 202 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
    }
  };
}
