import type { ShaleSDK } from "@shale/sdk";
import { runWorker } from "./worker";
const scheduled = new WeakMap<
  object,
  {
    timer?: ReturnType<typeof setTimeout>;
    runAt?: number;
    running: boolean;
    requested: boolean;
  }
>();
/** Coalesce admission bursts. Cron remains the persistent wakeup/recovery fallback. */
export function wakeBrowserWorker(sdk: ShaleSDK) {
  let state = scheduled.get(sdk.database);
  if (!state) {
    state = { running: false, requested: false };
    scheduled.set(sdk.database, state);
  }
  if (state.running) {
    state.requested = true;
    return;
  }
  const current = state;
  const retry = sdk.database
    .query<{ due: number | null }, [string]>(
      "SELECT min(next_attempt_at) AS due FROM browser_jobs WHERE extension_id=? AND state IN ('received','prepared')",
    )
    .get(sdk.extensionId)?.due;
  const delay = Math.max(
    Math.max(
      100,
      Math.min(60000, sdk.settings.get<number>("collectionWindowMs") ?? 3000),
    ),
    retry ? retry - Date.now() : 0,
  );
  const runAt = Date.now() + Math.min(3600000, delay);
  if (current.timer && (current.runAt ?? 0) <= runAt) return;
  if (current.timer) clearTimeout(current.timer);
  current.runAt = runAt;
  current.timer = setTimeout(
    async () => {
      current.timer = undefined;
      current.running = true;
      current.requested = false;
      try {
        const result = await runWorker(sdk);
        if ((result.queuedPayloads ?? 0) > 0) current.requested = true;
      } catch (error) {
        sdk.logger.error("Browser background worker failed:", error);
      } finally {
        current.running = false;
        if (current.requested) wakeBrowserWorker(sdk);
      }
    },
    Math.min(3600000, delay),
  );
  current.timer.unref?.();
}
