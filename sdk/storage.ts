import { AsyncLocalStorage } from "node:async_hooks";
import type { ShaleSDK } from "./extension-sdk";

/** SDK identity only; GPU reservations continue to propagate independently. */
export const sdkStorage = new AsyncLocalStorage<ShaleSDK>();

export function runWithSDK<T>(sdk: ShaleSDK, fn: () => T): T {
  return sdkStorage.run(sdk, fn);
}
