import { describe, expect, it, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isTExtensionManifest,
  type ExtensionManifest,
} from "../lib/extension";
import {
  saveCheckpoint,
  getQueuedCheckpoints,
  getAllCheckpoints,
  getCheckpoint,
  hasQueuedCheckpoints,
  deleteCheckpoint,
  clearQueuedCheckpoints,
  clearAllCheckpoints,
  updateCheckpointStatus,
} from "../lib/db";
import {
  wait_for_checkpoint_script,
  runCron,
  runCheckpointRecover,
} from "../main/index";
import {
  registerCheckpointRecoverScript,
  checkpointRecoverScripts,
} from "../main/load-extensions";
import { createExtensionSDK, getActiveSDK, getCheckpointContext } from "../sdk";

describe("Extension Checkpoint & Recovery System", () => {
  const testExtId = "test-checkpoint-ext-" + Date.now();

  beforeEach(() => {
    clearAllCheckpoints(testExtId);
  });

  describe("Extension Manifest Typing & Validation", () => {
    it("validates manifest with checkpoint_recover script string", () => {
      const validManifest: ExtensionManifest = {
        name: "test-plugin",
        version: "1.0.0",
        description: "A test plugin with recovery",
        checkpoint_recover: "recover.ts",
      };

      expect(isTExtensionManifest(validManifest)).toBe(true);
    });

    it("validates manifest without checkpoint_recover (backwards compatibility)", () => {
      const validLegacyManifest = {
        name: "legacy-plugin",
        version: "1.0.0",
        description: "Legacy plugin without recovery",
      };

      expect(isTExtensionManifest(validLegacyManifest)).toBe(true);
    });

    it("rejects manifest with non-string checkpoint_recover", () => {
      const invalidManifest = {
        name: "invalid-plugin",
        version: "1.0.0",
        description: "Invalid checkpoint recover type",
        checkpoint_recover: 12345,
      };

      expect(isTExtensionManifest(invalidManifest)).toBe(false);
    });
  });

  describe("Database Checkpoint Operations", () => {
    it("saves and retrieves queued checkpoints", () => {
      const record1 = saveCheckpoint({
        extension_id: testExtId,
        checkpoint_key: "batch-1",
        data: { files: ["file1.md", "file2.md"], cursor: 42 },
      });

      expect(record1.id).toBeDefined();
      expect(record1.extension_id).toBe(testExtId);
      expect(record1.checkpoint_key).toBe("batch-1");
      expect(record1.status).toBe("queued");
      expect(JSON.parse(record1.data)).toEqual({
        files: ["file1.md", "file2.md"],
        cursor: 42,
      });

      expect(hasQueuedCheckpoints(testExtId)).toBe(true);

      const queue = getQueuedCheckpoints(testExtId);
      expect(queue.length).toBe(1);
      expect(queue[0].id).toBe(record1.id);

      const retrieved = getCheckpoint(record1.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(record1.id);
    });

    it("clears and deletes checkpoints correctly", () => {
      const r1 = saveCheckpoint({
        extension_id: testExtId,
        checkpoint_key: "cp-1",
        data: "work-1",
      });
      const r2 = saveCheckpoint({
        extension_id: testExtId,
        checkpoint_key: "cp-2",
        data: "work-2",
      });

      expect(getQueuedCheckpoints(testExtId).length).toBe(2);

      // Delete one
      expect(deleteCheckpoint(r1.id)).toBe(true);
      expect(getQueuedCheckpoints(testExtId).length).toBe(1);

      // Clear all queued
      clearQueuedCheckpoints(testExtId);
      expect(hasQueuedCheckpoints(testExtId)).toBe(false);
    });

    it("updates checkpoint status", () => {
      const cp = saveCheckpoint({
        extension_id: testExtId,
        checkpoint_key: "status-test",
        data: "test-data",
      });

      expect(hasQueuedCheckpoints(testExtId)).toBe(true);

      updateCheckpointStatus(cp.id, "processing");
      expect(hasQueuedCheckpoints(testExtId)).toBe(false);

      const all = getAllCheckpoints(testExtId);
      expect(all.length).toBe(1);
      expect(all[0].status).toBe("processing");
    });
  });

  describe("Checkpoint Recovery & Cron Delay Integration", () => {
    it("delays cron execution until checkpoint recovery finishes and runs right after", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
      const executionLog: string[] = [];

      // Save checkpoints in queue for this extension
      saveCheckpoint({
        extension_id: testExtId,
        checkpoint_key: "partial-vault-data",
        data: { pendingVaults: ["VaultA", "VaultB"] },
      });

      // Write recovery script
      const recoverScriptPath = join(tempDir, "recover.ts");
      writeFileSync(
        recoverScriptPath,
        `
        import { getCheckpointContext } from "@shale/sdk";
        export async function run(sdk: any, context: any) {
          // Verify SDK function provides the context
          const sdkContext = sdk.getCheckpointContext();
          if (!sdkContext || sdkContext.count === 0) {
            throw new Error("Missing context from SDK function");
          }

          // Delay slightly to simulate asynchronous recovery work
          await new Promise((resolve) => setTimeout(resolve, 50));
          executionLog.push("recovered:" + sdkContext.checkpoints[0].key);
        }
        `,
      );

      // Write cron script
      const cronScriptPath = join(tempDir, "cron.ts");
      writeFileSync(
        cronScriptPath,
        `
        export async function run(sdk: any) {
          executionLog.push("cron-executed:" + sdk.extensionId);
        }
        `,
      );

      // Register the recovery script for this extension
      registerCheckpointRecoverScript(testExtId, recoverScriptPath);

      // Create a global reference to pass executionLog into scripts
      (globalThis as any).executionLog = executionLog;

      // Run cron
      const cron = {
        name: "test-cron-delay",
        schedule: "* * * * *",
        script: cronScriptPath,
        extensionId: testExtId,
        namespace: "test-ns",
      };

      await runCron(cron);

      // Verification:
      // 1. Recovery script ran FIRST
      // 2. Cron ran RIGHT AFTER
      expect(executionLog).toEqual([
        "recovered:partial-vault-data",
        `cron-executed:${testExtId}`,
      ]);

      // Checkpoints should have been cleaned up after recovery
      expect(hasQueuedCheckpoints(testExtId)).toBe(false);
    });

    it("runs cron immediately without delay if there are no checkpoints in queue", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "checkpoint-no-queue-"));
      const executionLog: string[] = [];
      (globalThis as any).executionLog = executionLog;

      const recoverScriptPath = join(tempDir, "recover.ts");
      writeFileSync(
        recoverScriptPath,
        `
        export async function run() {
          executionLog.push("should-not-run");
        }
        `,
      );
      registerCheckpointRecoverScript(testExtId, recoverScriptPath);

      const cronScriptPath = join(tempDir, "cron.ts");
      writeFileSync(
        cronScriptPath,
        `
        export async function run(sdk: any) {
          executionLog.push("cron-ran-immediately");
        }
        `,
      );

      const cron = {
        name: "test-cron-no-queue",
        schedule: "* * * * *",
        script: cronScriptPath,
        extensionId: testExtId,
        namespace: "test-ns",
      };

      // Ensure no checkpoints
      clearAllCheckpoints(testExtId);

      await runCron(cron);

      expect(executionLog).toEqual(["cron-ran-immediately"]);
    });

    it("provides appropriate context to recovery script via SDK getCheckpointContext()", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "checkpoint-context-test-"));
      let receivedCount = 0;
      let receivedExtensionId = "";
      let receivedKey = "";
      let receivedData: any = null;

      saveCheckpoint({
        extension_id: testExtId,
        checkpoint_key: "important-crash-data",
        data: { unwrittenRecords: [1, 2, 3] },
      });

      const recoverScriptPath = join(tempDir, "recover.ts");
      writeFileSync(
        recoverScriptPath,
        `
        export async function run(sdk: any, context: any) {
          // Test SDK function getCheckpointContext()
          const ctxFromSdk = sdk.getCheckpointContext();
          receivedCount = ctxFromSdk.count;
          receivedExtensionId = ctxFromSdk.extensionId;
          receivedKey = ctxFromSdk.checkpoints[0].key;
          receivedData = ctxFromSdk.checkpoints[0].data;
        }
        `,
      );

      (globalThis as any).setContextVars = (count: number, ext: string, key: string, data: any) => {
        receivedCount = count;
        receivedExtensionId = ext;
        receivedKey = key;
        receivedData = data;
      };

      // Update script to call global helper
      writeFileSync(
        recoverScriptPath,
        `
        export async function run(sdk: any, context: any) {
          const ctx = sdk.getCheckpointContext();
          (globalThis as any).setContextVars(
            ctx.count,
            ctx.extensionId,
            ctx.checkpoints[0].key,
            ctx.checkpoints[0].data
          );
        }
        `,
      );

      await runCheckpointRecover(testExtId, recoverScriptPath);

      expect(receivedCount).toBe(1);
      expect(receivedExtensionId).toBe(testExtId);
      expect(receivedKey).toBe("important-crash-data");
      expect(receivedData).toEqual({ unwrittenRecords: [1, 2, 3] });
    });

    it("preserves checkpoints in queue if the recovery script encounters an error", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "checkpoint-fail-"));

      saveCheckpoint({
        extension_id: testExtId,
        checkpoint_key: "fail-recover",
        data: { crucialData: true },
      });

      const recoverScriptPath = join(tempDir, "failing-recover.ts");
      writeFileSync(
        recoverScriptPath,
        `
        export async function run() {
          throw new Error("Crash during recovery!");
        }
        `,
      );
      registerCheckpointRecoverScript(testExtId, recoverScriptPath);

      const cronScriptPath = join(tempDir, "cron.ts");
      writeFileSync(
        cronScriptPath,
        `
        export async function run() {
          // cron runs after recovery attempt finishes
        }
        `,
      );

      const cron = {
        name: "test-cron-fail-rec",
        schedule: "* * * * *",
        script: cronScriptPath,
        extensionId: testExtId,
        namespace: "test-ns",
      };

      // Should not throw unhandled exception
      await runCron(cron);

      // Checkpoint must NOT be deleted because recovery failed
      expect(hasQueuedCheckpoints(testExtId)).toBe(true);
    });

    it("waits for an already in-flight recovery across multiple concurrent crons", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "concurrent-cron-"));
      const executionOrder: string[] = [];
      (globalThis as any).executionOrder = executionOrder;

      saveCheckpoint({
        extension_id: testExtId,
        checkpoint_key: "multi-cron",
        data: "shared",
      });

      const recoverScriptPath = join(tempDir, "slow-recover.ts");
      writeFileSync(
        recoverScriptPath,
        `
        export async function run() {
          executionOrder.push("recover-start");
          await new Promise(r => setTimeout(r, 60));
          executionOrder.push("recover-end");
        }
        `,
      );
      registerCheckpointRecoverScript(testExtId, recoverScriptPath);

      const cronScriptPath1 = join(tempDir, "cron1.ts");
      writeFileSync(
        cronScriptPath1,
        `
        export async function run() {
          executionOrder.push("cron-1-run");
        }
        `,
      );

      const cronScriptPath2 = join(tempDir, "cron2.ts");
      writeFileSync(
        cronScriptPath2,
        `
        export async function run() {
          executionOrder.push("cron-2-run");
        }
        `,
      );

      const cron1 = {
        name: "cron-1",
        schedule: "* * * * *",
        script: cronScriptPath1,
        extensionId: testExtId,
      };

      const cron2 = {
        name: "cron-2",
        schedule: "* * * * *",
        script: cronScriptPath2,
        extensionId: testExtId,
      };

      // Trigger both crons concurrently
      await Promise.all([runCron(cron1), runCron(cron2)]);

      // Both crons should only run AFTER recovery has completed!
      expect(executionOrder[0]).toBe("recover-start");
      expect(executionOrder[1]).toBe("recover-end");
      expect(executionOrder.slice(2).sort()).toEqual(["cron-1-run", "cron-2-run"]);
    });
  });
});
