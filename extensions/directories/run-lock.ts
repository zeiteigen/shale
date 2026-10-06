import type { ShaleSDK } from "@shale/sdk";

const active = new WeakMap<ShaleSDK["database"], Set<string>>();

/** Prevent manual scans and recovery from replacing each other's checkpoints. */
export async function withDirectoryRun<T>(sdk: ShaleSDK, work: () => Promise<T>): Promise<T> {
  const running = active.get(sdk.database) ?? new Set<string>();
  active.set(sdk.database, running);
  if (running.has(sdk.extensionId)) throw new Error("Directory ingestion or recovery is already running");
  running.add(sdk.extensionId);
  try { return await work(); }
  finally { running.delete(sdk.extensionId); }
}
