import type { ShaleSDK } from "@shale/sdk";
import type { BrowserExtensionSettings } from "./settings.types";
const bounds: Record<string, [number, number, number]> = {
  maxPublicPagesPerRun: [2, 1, 10],
  maxPendingJobs: [5000, 1, 50000],
  maxPendingBytes: [50000000, 1000000, 500000000],
  maxJobsPerRun: [20, 1, 100],
  maxBatchBytes: [1000000, 100000, 10000000],
  maxJobAttempts: [5, 1, 20],
  maxSessionsPerRun: [3, 1, 20],
  maxSessionEvents: [200, 10, 500],
  collectionWindowMs: [3000, 100, 60000],
  maxEmbeddingTexts: [64, 1, 256],
};
export function browserSettings(sdk: ShaleSDK): BrowserExtensionSettings {
  const settings = sdk.settings.getAll<BrowserExtensionSettings>();
  for (const [key, [fallback, min, max]] of Object.entries(bounds)) {
    const value = (settings as any)[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(
        `Invalid browser setting ${key}: expected integer ${min}..${max}`,
      );
    (settings as any)[key] = value;
  }
  return settings;
}
