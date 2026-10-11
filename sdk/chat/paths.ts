import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "../..");

/** Resolve `~/`, absolute, and project-relative paths (e.g. `./data/discord/import`). */
export function resolveDataPath(path: string): string {
  if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(1));
  return isAbsolute(path) ? path : resolve(PROJECT_ROOT, path);
}
