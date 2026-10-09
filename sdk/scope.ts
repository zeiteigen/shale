import { sdkStorage } from "./storage";
export { sdkStorage, runWithSDK } from "./storage";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import type { ExtensionManifest } from "../lib/extension";
import { ShaleSDK, createExtensionSDK } from "./extension-sdk";

export interface DiscoveredManifest {
  path: string;
  dir: string;
  manifest: ExtensionManifest;
}

/**
 * Cache for discovered SDK instances keyed by manifest file path.
 */
const manifestSdkCache = new Map<string, ShaleSDK>();

/**
 * Default fallback SDK instance when outside any extension directory or context.
 */
let defaultSdkInstance: ShaleSDK | null = null;

/**
 * Traverses parent directories upwards from a starting path to find the nearest manifest.json.
 */
export function findNearestManifest(
  startPath: string = process.cwd(),
): DiscoveredManifest | null {
  try {
    let cur = resolve(startPath);
    if (existsSync(cur)) {
      try {
        const stat = Bun.file(cur);
        if (stat.size !== undefined && !cur.endsWith("/")) {
          if (/\.[a-zA-Z0-9]+$/.test(cur)) {
            cur = dirname(cur);
          }
        }
      } catch {}
    }

    while (cur && cur !== dirname(cur)) {
      const candidate = join(cur, "manifest.json");
      if (existsSync(candidate)) {
        try {
          const content = readFileSync(candidate, "utf-8");
          const parsed = JSON.parse(content) as ExtensionManifest;
          if (parsed && typeof parsed === "object" && parsed.name) {
            return {
              path: candidate,
              dir: cur,
              manifest: parsed,
            };
          }
        } catch {}
      }
      cur = dirname(cur);
    }
  } catch {}

  return null;
}

/**
 * Inspects the call stack to determine the directory of the calling file outside the SDK.
 */
export function detectCallerDir(): string | null {
  try {
    const err = new Error();
    const stack = err.stack;
    if (!stack) return null;

    const lines = stack.split("\n");
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(
        /(?:at\s+(?:.*?\s+\()?|^\s*)([/\\][^\s:()]+?)(?::\d+)?(?::\d+)?\)?$/,
      );
      if (match && match[1]) {
        const filePath = match[1];
        if (
          !filePath.includes("/sdk/") &&
          !filePath.endsWith("sdk/index.ts") &&
          !filePath.includes("node:") &&
          !filePath.includes("bun:")
        ) {
          return dirname(filePath);
        }
      }
    }
  } catch {}

  return null;
}

/**
 * Resolves the currently active ShaleSDK instance.
 *
 * Resolution precedence:
 * 1. AsyncLocalStorage (set by host runner e.g. `main` or `runWithSDK`)
 * 2. Lexical/global `shared.sdk` (used during in-memory cron script execution)
 * 3. Nearest `manifest.json` auto-discovered from caller's file location or process entrypoint
 * 4. Default fallback SDK ("default")
 */
export function getSDK(dirOrPath?: string): ShaleSDK {
  // 1. Check AsyncLocalStorage
  const store = sdkStorage.getStore();
  if (store) {
    return store;
  }

  // 2. Check global/lexical `shared.sdk`
  if (
    typeof (globalThis as any).shared !== "undefined" &&
    (globalThis as any).shared?.sdk instanceof ShaleSDK
  ) {
    return (globalThis as any).shared.sdk;
  }

  // 3. Auto-discover manifest.json
  const targetDir =
    dirOrPath ??
    detectCallerDir() ??
    (process.argv[1] ? dirname(process.argv[1]) : undefined) ??
    process.cwd();

  const discovered = findNearestManifest(targetDir);
  if (discovered) {
    const cached = manifestSdkCache.get(discovered.path);
    if (cached) {
      return cached;
    }

    const extId = discovered.manifest.name;
    const ns = discovered.manifest.namespace || extId;
    const sdk = createExtensionSDK(
      extId,
      ns,
      undefined,
      undefined,
      undefined,
      discovered.dir,
    );
    manifestSdkCache.set(discovered.path, sdk);
    return sdk;
  }

  // 4. Default fallback
  if (!defaultSdkInstance) {
    defaultSdkInstance = createExtensionSDK(
      "default",
      "default",
      undefined,
      undefined,
      undefined,
      process.cwd(),
    );
  }
  return defaultSdkInstance;
}

export const getActiveSDK = getSDK;
