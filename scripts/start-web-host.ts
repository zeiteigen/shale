import { join } from "node:path";

/** Compatibility launchers enter the same daemon rather than starting another UI server. */
export async function runWebHost() {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../main/index.ts"), ...process.argv.slice(2)], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.exit(await child.exited);
}
