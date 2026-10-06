import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ShaleSDK } from "@shale/sdk";

export function fileStateKey(namespace: string, path: string): string {
  return `file:${JSON.stringify([namespace, pathToFileURL(path).href])}`;
}

export function checkpointId(sdk: ShaleSDK, namespace: string, path: string): string {
  return `directory_file:${createHash("sha256").update(JSON.stringify([sdk.extensionId, namespace, path])).digest("hex")}`;
}
