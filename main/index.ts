import ingestQueue from "./ingest-queue";
import { isIngestMaterial } from "../lib/ingest.types";
import { crons } from "./load-extensions";
import { createExtensionSDK, sdkStorage } from "../sdk";
import type { CronExtension } from "../lib/extension";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

Bun.serve({
  port: 7425,
  routes: {
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

console.log("Loaded crons:", crons);

export async function runCron(cron: CronExtension) {
  try {
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

for (const cron of crons) {
  Bun.cron(cron.schedule, async () => {
    await runCron(cron);
  });
}

if (process.argv.includes("--run-all-cron")) {
  console.log("Running all cron scripts on startup (--run-all-cron)...");
  await runAllCrons();
}
