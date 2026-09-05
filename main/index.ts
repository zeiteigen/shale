import ingestQueue from "./ingest-queue";
import { isIngestMaterial } from "../lib/ingest.types";
import { crons } from "./load-extensions";

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

for (const cron of crons) {
  console.log("A");
  Bun.cron(cron.schedule, async () => {
    try {
      const code = await Bun.file(cron.script).text();

      // Transpile TypeScript/JSX to raw JavaScript in-memory
      const transpiler = new Bun.Transpiler({ loader: "ts" });
      const jsCode = transpiler.transformSync(code);

      // Wrap in a function that receives your shared state/imports as arguments
      const runFn = new AsyncFunction("shared", jsCode);

      await runFn();
    } catch (err: any) {
      console.log("Err in cron:", JSON.stringify(err));
    }
  });
}
