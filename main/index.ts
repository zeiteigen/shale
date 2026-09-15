import { dirname, join } from "node:path";
import ingestQueue from "./ingest-queue";
import "./ingest-router";
import { isIngestMaterial } from "../lib/ingest.types";
import {
  crons,
  checkpointRecoverScripts,
  extensionNamespaces,
  getCheckpointRecoverScript,
} from "./load-extensions";
import { createExtensionSDK, sdkStorage, findNearestManifest } from "../sdk";
import { hasQueuedCheckpoints } from "../lib/db";
import type { CronExtension } from "../lib/extension";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

if (import.meta.main) {
  try {
    Bun.serve({
      port: Number(process.env.PORT) || 7425,
      routes: {
        "/health": () => Response.json({ status: "ok", service: "shale" }),
        "/ingest": async (req) => {
          try {
            const body = await req.json();

            if (!isIngestMaterial(body)) {
              return new Response("ERR");
            }

            ingestQueue.add(body);
            return new Response("OK");
          } catch (err: any) {
            console.log("Err in /ingest:", JSON.stringify(err));
            return new Response("ERR");
          }
        },
      },
    });
    console.log("Ingest server running on port 7425");
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") {
      console.warn(
        "Port 7425 is already in use, skipping HTTP server startup in this process.",
      );
    } else {
      throw err;
    }
  }
}

console.log("Loaded crons:", crons);

const inFlightRecoveries = new Map<string, Promise<void>>();

export async function runCheckpointRecover(
  extensionId: string,
  scriptPath: string,
  namespace?: string,
): Promise<void> {
  const ns = namespace ?? extensionNamespaces.get(extensionId) ?? extensionId;
  const sdk = createExtensionSDK(extensionId, ns);
  const context = sdk.getCheckpointContext();
  if (context.count === 0) {
    return;
  }

  await sdkStorage.run(sdk, async () => {
    let mod: any;
    try {
      mod = await import(scriptPath);
    } catch {
      // Fall back to transpilation/AsyncFunction if dynamic import fails
    }

    if (mod) {
      if (typeof mod.run === "function") {
        await mod.run(sdk, context);
        for (const cp of context.checkpoints) {
          sdk.deleteCheckpoint(cp.id);
        }
        return;
      }
      if (typeof mod.default === "function") {
        await mod.default(sdk, context);
        for (const cp of context.checkpoints) {
          sdk.deleteCheckpoint(cp.id);
        }
        return;
      }
    }

    const code = await Bun.file(scriptPath).text();
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const jsCode = transpiler.transformSync(code);
    const runFn = new AsyncFunction("shared", jsCode);

    await runFn({ sdk, context });
    for (const cp of context.checkpoints) {
      sdk.deleteCheckpoint(cp.id);
    }
  });
}

export async function wait_for_checkpoint_script(
  extensionId: string,
  cron?: CronExtension,
): Promise<void> {
  if (inFlightRecoveries.has(extensionId)) {
    await inFlightRecoveries.get(extensionId);
    return;
  }

  let scriptPath = getCheckpointRecoverScript(extensionId);
  if (!scriptPath && cron?.script) {
    try {
      const discovered = findNearestManifest(dirname(cron.script));
      if (discovered?.manifest?.checkpoint_recover) {
        scriptPath = join(discovered.dir, discovered.manifest.checkpoint_recover);
      }
    } catch {}
  }

  if (!scriptPath) {
    return;
  }

  if (!hasQueuedCheckpoints(extensionId)) {
    return;
  }

  const recoveryPromise = (async () => {
    try {
      await runCheckpointRecover(extensionId, scriptPath, cron?.namespace);
    } catch (err: any) {
      console.error(
        `Error in checkpoint recovery for extension ${extensionId}:`,
        err?.message || err,
      );
    } finally {
      inFlightRecoveries.delete(extensionId);
    }
  })();

  inFlightRecoveries.set(extensionId, recoveryPromise);
  await recoveryPromise;
}

export async function runCron(cron: CronExtension) {
  try {
    const extensionId = cron.extensionId || "default";
    await wait_for_checkpoint_script(extensionId, cron);

    const sdk = createExtensionSDK(
      cron.extensionId || "default",
      cron.namespace,
    );

    // Run within AsyncLocalStorage scope so any imported extension files/functions share the scope
    await sdkStorage.run(sdk, async () => {
      let mod: any;
      try {
        mod = await import(cron.script);
      } catch {
        // Fall back to transpilation/AsyncFunction if dynamic import fails
      }

      if (mod) {
        if (typeof mod.run === "function") {
          await mod.run(sdk);
          return;
        }
        if (typeof mod.default === "function") {
          await mod.default(sdk);
          return;
        }
      }

      const code = await Bun.file(cron.script).text();

      // Transpile TypeScript/JSX to raw JavaScript in-memory
      const transpiler = new Bun.Transpiler({ loader: "ts" });
      const jsCode = transpiler.transformSync(code);

      // Wrap in a function that receives your shared state/imports as arguments
      const runFn = new AsyncFunction("shared", jsCode);

      await runFn({ sdk });
    });
  } catch (err: any) {
    console.log("Err in cron:", err?.message || err);
  }
}

export async function runAllCrons() {
  for (const cron of crons) {
    await runCron(cron);
  }
}

/** Run only crons explicitly marked for the host startup phase. */
export async function runStartupCrons() {
  for (const cron of crons) {
    if (cron.run_on_startup) {
      await runCron(cron);
    }
  }
}

for (const cron of crons) {
  Bun.cron(cron.schedule, async () => {
    await runCron(cron);
  });
}

if (import.meta.main) {
  await runStartupCrons();
}

if (import.meta.main && process.argv.includes("--run-all-cron")) {
  console.log("Running all cron scripts on startup (--run-all-cron)...");
  await runAllCrons();
}
