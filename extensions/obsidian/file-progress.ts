import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { ShaleSDK } from "@shale/sdk";

const key = (namespace: string, uri: string) => `file:${namespace}:${uri}:mtime`;

/** Call within the source transaction so failed graph writes never mark a file complete. */
export function recordCommittedFile(sdk: ShaleSDK, namespace: string, uri: string, updatedAt: number) {
  sdk.state.set(key(namespace, uri), String(updatedAt));
}

/** Retrying one failed attachment must not repeat chat work for completed files. */
export function unfinishedFiles(paths: string[], sdk: ShaleSDK, namespace: string, force: boolean): string[] {
  if (force) return paths;
  return paths.filter(path => {
    try {
      const completedAt = sdk.state.get(key(namespace, pathToFileURL(path).href));
      // Notes and images written by earlier parsers use unescaped file URIs.
      const legacyAt = sdk.state.get(key(namespace, `file://${resolve(path)}`));
      const mtime = Math.floor(statSync(path).mtimeMs);
      return ![completedAt, legacyAt].some(value => value !== null && Number(value) === mtime);
    } catch { return true; }
  });
}
