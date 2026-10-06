import { lstat, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import type { DirectorySettings } from "./settings.types";
import type { DirectoryInfo } from "./types";

export async function resolveDirectory(path: string): Promise<DirectoryInfo> {
  if (typeof path !== "string" || !path.trim()) throw new Error("Directory paths must be non-empty strings");
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const canonical = await realpath(resolve(expanded));
  if (!(await lstat(canonical)).isDirectory()) throw new Error(`Not a directory: ${path}`);
  return { path: canonical, name: basename(canonical) || canonical };
}

/** Stream discovery without following nested symlinks or blocking the daemon. */
export async function* scanFiles(directory: string, settings: DirectorySettings,
  onError?: (path: string, error: unknown) => void): AsyncGenerator<string> {
  const ignored = new Set((settings.ignoredDirectories ?? ["node_modules", "vendor", "dist", "build"]).map(name => name.toLowerCase()));
  const extensions = settings.fileExtensions?.map(extension => extension.replace(/^\./, "").toLowerCase());
  const entries = await opendir(directory);
  for await (const entry of entries) {
    if (settings.ignoreHidden !== false && entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (settings.recursive !== false && !ignored.has(entry.name.toLowerCase())) {
        try { yield* scanFiles(path, settings, onError); }
        catch (error) {
          if (!onError) throw error;
          onError(path, error);
        }
      }
    } else if (entry.isFile() && (!extensions?.length || extensions.includes(extname(entry.name).slice(1).toLowerCase()))) {
      yield path;
    }
  }
}

export async function fileVersion(path: string) {
  const stats = await lstat(path);
  if (!stats.isFile()) throw Object.assign(new Error(`Not a regular file: ${path}`), { code: "ENOTFILE" });
  return {
    fingerprint: JSON.stringify([stats.mtimeMs, stats.ctimeMs, stats.size, stats.ino]),
    updatedAt: Math.trunc(stats.mtimeMs),
    size: stats.size,
  };
}
