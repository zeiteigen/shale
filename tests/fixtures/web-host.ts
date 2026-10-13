import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "../../main/web-server";
import { WebLogs } from "../../main/web-logs";
import { trackCronRun } from "../../main/cron-runs";
import type { WebContext } from "../../main/web-api";

export function createWebHost(overrides: Partial<WebContext> = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), "shale-web-"));
  mkdirSync(join(rootDir, "extensions", "demo"), { recursive: true });
  mkdirSync(join(rootDir, "resources"));
  writeFileSync(join(rootDir, "package.json"), '{"name":"web-test"}');
  writeFileSync(join(rootDir, "resources/settings.json"), '{"PORT":7425}');
  writeFileSync(join(rootDir, "resources/settings.help.json"), JSON.stringify({ extension: "root", settings: {
    PORT: { type: "number", description: "Host port", default: 7425, integer: true, range: { min: 1, max: 65535 } },
  } }));
  writeFileSync(join(rootDir, "extensions/demo/manifest.json"), '{"name":"demo","description":"Demo settings"}');
  writeFileSync(join(rootDir, "extensions/demo/settings.json"), '{"enabled":true,"batchSize":4,"directories":[],"mode":"local","rules":{}}');
  writeFileSync(join(rootDir, "extensions/demo/settings.help.json"), JSON.stringify({ extension: "demo", settings: {
    enabled: { type: "boolean", description: "Enable processing", default: true },
    batchSize: { type: "number", description: "Batch size", default: 4, integer: true, range: { min: 1, max: 10 } },
    directories: { type: "string[]", description: "Folders to scan", default: [] },
    mode: { type: "string", description: "Model location", default: "local", possibleValues: ["local", "remote"] },
    rules: { type: "object", description: "Processing rules", default: {} },
  } }));
  const crons = [{ name: "demo-job", extensionId: "demo", script: "demo.ts", schedule: "0 */6 * * *" }];
  const logs = new WebLogs();
  logs.add("info", "[host] Ready for work.");
  let server: ReturnType<typeof startWebServer>;
  let shutdownCalled = false;
  const context: WebContext = {
    rootDir, crons, extensions: new Map([["demo", "demo"]]), logs,
    runCron: cron => trackCronRun(cron, async () => { logs.add("info", "Demo job completed."); }),
    runAllCrons: async () => { for (const cron of crons) await context.runCron(cron); },
    command: async line => ({ success: line === "help", output: line === "help" ? "Available CLI Commands: cron list, settings get root, status" : "Unknown command" }),
    shutdown: () => { shutdownCalled = true; },
    port: () => server.port!, ...overrides,
  };
  server = startWebServer(context, {
    health: () => Response.json({ status: "ok" }),
    connectors: () => Response.json({ processors: ["demo"] }),
    connector: () => Response.json({ status: "idle" }),
    ingest: () => Response.json({ accepted: true }, { status: 202 }),
  }, 0);
  return {
    server, context, rootDir, base: `http://127.0.0.1:${server.port}`,
    get shutdownCalled() { return shutdownCalled; },
    close() { server.stop(true); rmSync(rootDir, { recursive: true, force: true }); },
  };
}
