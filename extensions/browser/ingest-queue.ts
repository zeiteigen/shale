import type { ShaleSDK } from "@shale/sdk";
import type { BrowserIngestPayload } from "./types";

const QUEUE_KEY = "pending-ingest";

export interface QueuedBrowserPayload {
  id: string;
  receivedAt: number;
  payload: BrowserIngestPayload;
}

/** A durable, extension-scoped inbox. The HTTP subscriber only ever appends here. */
export function enqueueBrowserPayload(sdk: ShaleSDK, payload: BrowserIngestPayload): number {
  const queue = sdk.state.getJson<QueuedBrowserPayload[]>(QUEUE_KEY) ?? [];
  queue.push({ id: crypto.randomUUID(), receivedAt: Date.now(), payload });
  sdk.state.setJson(QUEUE_KEY, queue);
  return queue.length;
}

export function getQueuedBrowserPayloads(sdk: ShaleSDK): QueuedBrowserPayload[] {
  return sdk.state.getJson<QueuedBrowserPayload[]>(QUEUE_KEY) ?? [];
}

export function replaceQueuedBrowserPayloads(
  sdk: ShaleSDK,
  queue: QueuedBrowserPayload[],
): void {
  if (queue.length === 0) sdk.state.delete(QUEUE_KEY);
  else sdk.state.setJson(QUEUE_KEY, queue);
}

/**
 * Acknowledge only the payloads that were actually processed. This preserves
 * items appended by the HTTP subscriber while a cron batch is running.
 */
export function acknowledgeQueuedBrowserPayloads(
  sdk: ShaleSDK,
  ids: Iterable<string>,
): number {
  const acknowledged = new Set(ids);
  if (acknowledged.size === 0) return 0;

  const current = getQueuedBrowserPayloads(sdk);
  const remaining = current.filter((item) => !acknowledged.has(item.id));
  replaceQueuedBrowserPayloads(sdk, remaining);
  return current.length - remaining.length;
}
