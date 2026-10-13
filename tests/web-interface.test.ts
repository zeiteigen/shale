import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWebHost } from "./fixtures/web-host";
import { SettingsManager } from "../sdk/settings";
import { getCronRun, trackCronRun } from "../main/cron-runs";
import { WebLogs } from "../main/web-logs";

function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("unified local web interface", () => {
  it("serves host, graph, health, connectors and ingestion from one local server", async () => {
    const host = createWebHost();
    try {
      for (const path of ["/api/host", "/api/graph", "/api/health", "/health", "/connectors", "/connectors/demo/status"]) {
        expect((await fetch(host.base + path)).status).toBe(200);
      }
      const status = await (await fetch(host.base + "/api/host")).json();
      expect(status.port).toBe(host.server.port);
      expect(status.extensions).toEqual([{ name: "demo", namespace: "demo" }]);
      expect((await post(host.base, "/ingest", {})).status).toBe(202);
      expect((await fetch(host.base + "/api/unknown")).status).toBe(404);
      expect((await post(host.base, "/api/search/bm25", { query: "unmatched" })).status).toBe(200);
    } finally { host.close(); }
  });

  it("blocks external origins and hostnames before reads, settings writes and shutdown", async () => {
    const host = createWebHost();
    try {
      const file = join(host.rootDir, "extensions/demo/settings.json");
      const original = readFileSync(file, "utf8");
      expect((await post(host.base, "/api/settings/demo", { key: "enabled", value: "false" }, { Origin: "https://external.example" })).status).toBe(403);
      expect(readFileSync(file, "utf8")).toBe(original);
      expect((await fetch(host.base + "/api/host", { headers: { Host: "evil.example" } })).status).toBe(403);
      expect((await post(host.base, "/api/shutdown", { confirm: true }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
      expect(host.shutdownCalled).toBe(false);
      expect((await fetch(host.base + "/api/host", { headers: { Origin: host.base } })).status).toBe(200);
    } finally { host.close(); }
  });

  it("validates root and extension edits, persists arrays, and hot-reloads the SDK", async () => {
    const host = createWebHost();
    try {
      const settings = new SettingsManager<{ enabled: boolean; directories: string[]; batchSize: number }>(join(host.rootDir, "extensions/demo"));
      const targets = await (await fetch(host.base + "/api/settings")).json();
      expect(targets.targets.map((target: { name: string }) => target.name)).toEqual(["root", "demo"]);
      expect((await post(host.base, "/api/settings/demo", { key: "enabled", value: "false" })).status).toBe(200);
      expect(settings.get<boolean>("enabled")).toBe(false);
      expect((await post(host.base, "/api/settings/demo", { key: "directories", value: '["/tmp/notes"]' })).status).toBe(200);
      expect(settings.get<string[]>("directories")).toEqual(["/tmp/notes"]);
      for (const [key, value] of [["batchSize", "11"], ["mode", "invalid"], ["rules", "[]"], ["directories", "[1]"], ["__proto__", "{}"]]) {
        expect((await post(host.base, "/api/settings/demo", { key, value })).status).toBe(400);
      }
      expect(settings.get<number>("batchSize")).toBe(4);
      writeFileSync(join(host.rootDir, "resources/settings.json"), '{"PORT":7425,"OPENAI_ENDPOINT":"http://localhost:8080/v1","VISUALIZER_PORT":3333}');
      const root = await (await fetch(host.base + "/api/settings/root")).json();
      expect(root.values).toEqual({ PORT: 7425 });
      expect(root.schema).not.toHaveProperty("OPENAI_ENDPOINT");
      expect(root.schema).not.toHaveProperty("VISUALIZER_PORT");
      expect((await post(host.base, "/api/settings/root", { key: "OPENAI_ENDPOINT", value: "http://localhost:8080/v1" })).status).toBe(400);
      expect((await post(host.base, "/api/settings/root", { key: "PORT", value: "8000" })).status).toBe(200);
      expect(JSON.parse(readFileSync(join(host.rootDir, "resources/settings.json"), "utf8"))).toEqual({ PORT: 8000 });
      expect((await post(host.base, "/api/settings/root", { key: "OPENAI_API_KEY", value: "secret" })).status).toBe(400);
      expect((await post(host.base, "/api/settings/demo", { key: "enabled", value: true })).status).toBe(400);
      expect((await post(host.base, "/api/settings/demo/reset", { key: "enabled" })).status).toBe(200);
      expect(settings.get<boolean>("enabled")).toBe(true);
      expect((await post(host.base, "/api/settings/demo/reset", {})).status).toBe(200);
      expect(settings.get<string[]>("directories")).toEqual([]);
      writeFileSync(join(host.rootDir, "extensions/demo/settings.json"), '{"batchSize":8}');
      const fresh = await (await fetch(host.base + "/api/settings/demo")).json();
      expect(fresh.values.batchSize).toBe(8);
      expect((await post(host.base, "/api/settings/missing", { key: "enabled", value: "true" })).status).toBe(404);
      expect((await fetch(host.base + "/api/settings/%2E%2E")).status).toBe(404);
    } finally { host.close(); }
  });

  it("accepts long jobs immediately, rejects duplicate manual runs, and reports failures", async () => {
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const host = createWebHost({ runCron: () => waiting });
    try {
      expect((await post(host.base, "/api/crons/run", { id: "0" })).status).toBe(202);
      expect((await fetch(host.base + "/api/host")).status).toBe(200);
      expect((await post(host.base, "/api/crons/run", { id: "0" })).status).toBe(409);
      finish(); await waiting; await Bun.sleep(5);
      let status = await (await fetch(host.base + "/api/host")).json();
      expect(status.tasks[0].status).toBe("succeeded");
      host.context.runCron = async () => { throw new Error("Job failed"); };
      expect((await post(host.base, "/api/crons/run", { id: "0" })).status).toBe(202);
      await Bun.sleep(5);
      status = await (await fetch(host.base + "/api/host")).json();
      expect(status.tasks[0].status).toBe("failed");
      expect(status.tasks[0].output).toContain("Job failed");
      expect((await post(host.base, "/api/crons/run", { id: "missing" })).status).toBe(400);
      expect((await post(host.base, "/api/command", { command: "help" })).status).toBe(202);
      await Bun.sleep(5);
      status = await (await fetch(host.base + "/api/host")).json();
      expect(status.tasks[0].output).toContain("Available CLI Commands");
      expect((await post(host.base, "/api/command", { command: "exit" })).status).toBe(400);
      expect((await post(host.base, "/api/command", { command: "settings tui" })).status).toBe(400);
      expect((await post(host.base, "/api/shutdown", {})).status).toBe(400);
      expect((await post(host.base, "/api/shutdown", { confirm: true })).status).toBe(200);
      await Bun.sleep(120);
      expect(host.shutdownCalled).toBe(true);
    } finally { finish(); host.close(); }
  });
});

it("coalesces scheduled/manual cron overlap and retains the failure for inspection", async () => {
  const cron = { schedule: "* * * * *", script: "demo.ts" };
  let reject!: (error: Error) => void;
  let calls = 0;
  const running = new Promise<void>((_, fail) => { reject = fail; });
  const first = trackCronRun(cron, () => { calls++; return running; });
  const second = trackCronRun(cron, async () => { calls++; });
  expect(first).toBe(second);
  expect(getCronRun(cron)?.status).toBe("running");
  reject(new Error("failed"));
  await expect(first).rejects.toThrow("failed");
  expect(calls).toBe(1);
  expect(getCronRun(cron)?.status).toBe("failed");
  expect(getCronRun(cron)?.finishedAt).toBeNumber();
});

it("bounds retained host output and strips terminal styling", () => {
  const logs = new WebLogs();
  for (let i = 0; i < 600; i++) logs.add("info", `\x1b[32mmessage ${i}\x1b[0m`);
  expect(logs.list()).toHaveLength(500);
  expect(logs.list()[0].text).toBe("message 100");
});
