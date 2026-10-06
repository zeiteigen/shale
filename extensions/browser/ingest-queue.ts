/** Compatibility API backed by the row-based durable inbox. */
import type { ShaleSDK } from "@shale/sdk";
import type { BrowserIngestPayload } from "./types";
import { admitBrowserPayload } from "./admission";
import { pendingJobs, finishJob } from "./inbox-store";
export interface QueuedBrowserPayload {
  id: string;
  receivedAt: number;
  payload: BrowserIngestPayload;
}
export function enqueueBrowserPayload(
  sdk: ShaleSDK,
  payload: BrowserIngestPayload,
): number {
  admitBrowserPayload(sdk, payload);
  return getQueuedBrowserPayloads(sdk).length;
}
export function getQueuedBrowserPayloads(
  sdk: ShaleSDK,
): QueuedBrowserPayload[] {
  return pendingJobs(sdk, 100000, false);
}
export function acknowledgeQueuedBrowserPayloads(
  sdk: ShaleSDK,
  ids: Iterable<string>,
): number {
  let count = 0;
  sdk.database.transaction(() => {
    for (const id of ids) {
      const row = sdk.database
        .query(
          "SELECT 1 FROM browser_jobs WHERE id=? AND extension_id=? AND state IN ('received','prepared')",
        )
        .get(id, sdk.extensionId);
      if (row) {
        finishJob(sdk, id);
        count++;
      }
    }
  })();
  return count;
}
export function replaceQueuedBrowserPayloads(
  sdk: ShaleSDK,
  queue: QueuedBrowserPayload[],
): void {
  const keep = new Set(queue.map((x) => x.id));
  acknowledgeQueuedBrowserPayloads(
    sdk,
    getQueuedBrowserPayloads(sdk)
      .filter((x) => !keep.has(x.id))
      .map((x) => x.id),
  );
}
