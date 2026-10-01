import { dirname, join } from "node:path";
import ingestQueue from "./ingest-queue";
import "./ingest-router";
import { handleIngestRequest } from "./ingest-http";
import {
  crons,
  checkpointRecoverScripts,
  extensionNamespaces,
  subscribe_ingest,
  getCheckpointRecoverScript,
} from "./load-extensions";
import { createExtensionSDK, sdkStorage, findNearestManifest, type ShaleSDK } from "../sdk";
import { hasQueuedCheckpoints } from "../lib/db";
import type { CronExtension } from "../lib/extension";
import { startCli } from "./cli";

export {
  startCli,
  handleCliCommand,
  triggerCron,
  triggerAllCrons,
  findMatchingCrons,
  listCrons,
  handleSettingsCliCommand,
  buildCandidates,
  getBestCommandSuggestion,
  getCompleterMatches,
  parseCommandLine,
} from "./cli";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const inFlightRecoveries = new Map<string, Promise<void>>();

export async function runCheckpointRecover(
  extensionId: string,
  scriptPath: string,
  namespace?: string,
  sdkOverride?: ShaleSDK,
): Promise<void> {
  const ns = namespace ?? extensionNamespaces.get(extensionId) ?? extensionId;
  const sdk = sdkOverride ?? createExtensionSDK(extensionId, {
    namespace: ns,
    extensionDir: dirname(scriptPath),
  });
  const context = sdk.getCheckpointContext();
  if (context.count === 0) {
    return;
  }

  await sdk.models.phase("embedding", () =>
    sdkStorage.run(sdk, async () => {
      let mod: any;
      try {
        mod = await import(scriptPath);
      } catch {
        // Fall back to transpilation/AsyncFunction if dynamic import fails
      }

      if (mod) {
        if (typeof mod.run === "function") {
          await mod.run(sdk, context);
          return;
        }
        if (typeof mod.default === "function") {
          await mod.default(sdk, context);
          return;
        }
      }

      const code = await Bun.file(scriptPath).text();
      const transpiler = new Bun.Transpiler({ loader: "ts" });
      const jsCode = transpiler.transformSync(code);
      const runFn = new AsyncFunction("shared", jsCode);

      await runFn({ sdk, context });
    }),
  );
}

export async function wait_for_checkpoint_script(
  extensionId: string,
  cron?: CronExtension,
  sdkOverride?: ShaleSDK,
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
        scriptPath = join(
          discovered.dir,
          discovered.manifest.checkpoint_recover,
        );
      }
    } catch {}
  }

  if (!scriptPath) {
    return;
  }

  if (!(sdkOverride ? sdkOverride.hasCheckpoints() : hasQueuedCheckpoints(extensionId))) {
    return;
  }

  const recoveryPromise = (async () => {
    try {
      await runCheckpointRecover(extensionId, scriptPath, cron?.namespace, sdkOverride);
    } catch (err: any) {
      console.error(
        `Error in checkpoint recovery for extension ${extensionId}:`,
        err?.message || err,
      );
      throw err;
    } finally {
      inFlightRecoveries.delete(extensionId);
    }
  })();

  inFlightRecoveries.set(extensionId, recoveryPromise);
  await recoveryPromise;
}

export async function runCron(cron: CronExtension, sdkOverride?: ShaleSDK) {
  const extensionId = cron.extensionId || "default";
  await wait_for_checkpoint_script(extensionId, cron, sdkOverride);

  const sdk = sdkOverride ?? createExtensionSDK(cron.extensionId || "default", {
    namespace: cron.namespace,
    extensionDir: dirname(cron.script),
  });

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
}

/** Run only crons explicitly marked for the host startup phase. */
export async function runStartupCrons() {
  for (const cron of crons) {
    if (cron.run_on_startup) {
      try {
        await runCron(cron);
      } catch (error) {
        console.error(`[cron] Startup job ${cron.name || cron.extensionId} failed:`, error);
      }
    }
  }
}

export async function runAllCrons() {
  const failures: unknown[] = [];
  for (const cron of crons) {
    try {
      await runCron(cron);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} cron job(s) failed`);
}

for (const cron of crons) {
  Bun.cron(cron.schedule, async () => {
    try {
      await runCron(cron);
    } catch (err) {
      console.error(`[cron] ${cron.name || cron.extensionId} failed:`, err);
    }
  });
}

if (import.meta.main) {
  try {
    Bun.serve({
      hostname: "127.0.0.1",
      port: Number(process.env.PORT) || 7425,
      routes: {
        "/health": () => Response.json({ status: "ok", service: "shale" }),
        "/ingest": (req) => handleIngestRequest(
          req,
          subscribe_ingest.map((hook) => hook.reciever_name),
          (item) => ingestQueue.push(item),
        ),
      },
    });
  } catch (err: any) {
    if (err.code === "EADDRINUSE") {
      console.warn(
        `[server] Port ${process.env.PORT || 7425} already in use; skipping HTTP server initialization.`,
      );
    } else {
      throw err;
    }
  }

  // Handle optional one-shot CLI arguments:
  // e.g. "bun run main/index.ts --run-all-cron" or "--cron <name>"
  const argv = process.argv.slice(2);
  const runAllIndex = argv.indexOf("--run-all-cron");
  const cronIndex = argv.indexOf("--cron");
  const noCli = argv.includes("--no-cli");

  if (runAllIndex !== -1) {
    await runAllCrons();
    process.exit(0);
  } else if (cronIndex !== -1 && argv[cronIndex + 1]) {
    const target = argv[cronIndex + 1];
    const targetCron = crons.find(
      (c) =>
        c.name === target ||
        c.extensionId === target ||
        c.script.includes(target),
    );
    if (!targetCron) {
      console.error(`[cron] No cron found matching "${target}"`);
      process.exit(1);
    }
    await runCron(targetCron);
    process.exit(0);
  }

  // Start the interactive CLI unless --no-cli is provided
  if (!noCli) {
    startCli();
  }

  // Run startup crons in background without blocking CLI prompt
  runStartupCrons().catch((err) => {
    console.error("[cron] Error running startup crons:", err);
  });
}
