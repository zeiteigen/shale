import { describe, expect, it } from "bun:test";
import {
  runCron,
  runAllCrons,
  triggerCron,
  handleCliCommand,
  listCrons,
  findMatchingCrons,
} from "../main/index";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("main/index cron runner and --run-all-cron", () => {
  it("executes a cron script that exports run()", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cron-test-"));
    const scriptPath = join(tempDir, "cron-run.ts");
    const markerFile = join(tempDir, "marker.txt");

    writeFileSync(
      scriptPath,
      `
      import { writeFileSync } from "node:fs";
      export async function run(sdk: any) {
        writeFileSync("${markerFile}", "executed-via-run:" + (sdk?.extensionId ?? "no-sdk"));
      }
      `,
    );

    const cron = {
      name: "test-cron-run",
      schedule: "* * * * *",
      script: scriptPath,
      extensionId: "test-ext-run",
      namespace: "test-ns-run",
    };

    await runCron(cron);

    const content = await Bun.file(markerFile).text();
    expect(content).toBe("executed-via-run:test-ext-run");
  });

  it("executes a cron script that exports default function", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cron-test-default-"));
    const scriptPath = join(tempDir, "cron-default.ts");
    const markerFile = join(tempDir, "marker.txt");

    writeFileSync(
      scriptPath,
      `
      import { writeFileSync } from "node:fs";
      export default async function(sdk: any) {
        writeFileSync("${markerFile}", "executed-via-default:" + (sdk?.extensionId ?? "no-sdk"));
      }
      `,
    );

    const cron = {
      name: "test-cron-default",
      schedule: "* * * * *",
      script: scriptPath,
      extensionId: "test-ext-default",
      namespace: "test-ns-default",
    };

    await runCron(cron);

    const content = await Bun.file(markerFile).text();
    expect(content).toBe("executed-via-default:test-ext-default");
  });

  it("handles errors gracefully without crashing", async () => {
    const cron = {
      name: "test-cron-fail",
      schedule: "* * * * *",
      script: "/non/existent/script/path.ts",
      extensionId: "test-ext-fail",
      namespace: "test-ns-fail",
    };

    // Should not throw
    await expect(runCron(cron)).resolves.toBeUndefined();
  });

  it("exports runAllCrons which iterates through all loaded crons", async () => {
    expect(typeof runAllCrons).toBe("function");
  });

  it("manually triggers a specific cron script via triggerCron", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cron-manual-"));
    const scriptPath = join(tempDir, "cron-manual.ts");
    const markerFile = join(tempDir, "manual-marker.txt");

    writeFileSync(
      scriptPath,
      `
      import { writeFileSync } from "node:fs";
      export async function run(sdk: any) {
        writeFileSync("${markerFile}", "manual-trigger-ok");
      }
      `,
    );

    const customCron = {
      name: "custom-manual-cron",
      schedule: "0 0 * * *",
      script: scriptPath,
      extensionId: "custom-ext",
      namespace: "custom-ns",
    };

    const res = await triggerCron("custom-manual-cron", {
      cronList: [customCron],
      runCronFn: runCron,
    });

    expect(res.success).toBe(true);
    expect(res.message).toContain('Cron "custom-manual-cron" completed successfully');
    const content = await Bun.file(markerFile).text();
    expect(content).toBe("manual-trigger-ok");
  });

  it("manually triggers a specific cron script via handleCliCommand", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cron-cli-cmd-"));
    const scriptPath = join(tempDir, "cron-cli.ts");
    const markerFile = join(tempDir, "cli-marker.txt");

    writeFileSync(
      scriptPath,
      `
      import { writeFileSync } from "node:fs";
      export async function run(sdk: any) {
        writeFileSync("${markerFile}", "cli-command-ok");
      }
      `,
    );

    const customCron = {
      name: "cli-triggered-cron",
      schedule: "0 0 * * *",
      script: scriptPath,
      extensionId: "cli-ext",
      namespace: "cli-ns",
    };

    const res = await handleCliCommand("cron run cli-triggered-cron", {
      crons: [customCron],
      runCronFn: runCron,
    });

    expect(res.success).toBe(true);
    expect(res.output).toContain('Cron "cli-triggered-cron" completed successfully');
    const content = await Bun.file(markerFile).text();
    expect(content).toBe("cli-command-ok");
  });
});
