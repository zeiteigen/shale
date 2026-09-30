import type { ShaleSDK } from "@shale/sdk";
import type { BrowserIngestPayload } from "./types";
import { normalizeUrl } from "./filter";

const QUEUE_KEY = "pending-ingest";
const MAX_HTML_CHARS = 20_000;
const MAX_LINKS = 100;
const MAX_IMAGES = 25;

export interface QueuedBrowserPayload {
  id: string;
  receivedAt: number;
  payload: BrowserIngestPayload;
}

function compactPayload(payload: BrowserIngestPayload): BrowserIngestPayload {
  if (payload.type !== "page_visit" && payload.type !== "active_page") return payload;
  return {
    ...payload,
    textContent: payload.textContent.slice(0, 20_000),
    excerpt: payload.excerpt?.slice(0, 500),
    html: payload.html?.slice(0, MAX_HTML_CHARS),
    links: payload.links?.slice(0, MAX_LINKS),
    images: payload.images?.slice(0, MAX_IMAGES),
  };
}

function pageQueueKey(payload: BrowserIngestPayload): string | null {
  if (payload.type !== "page_visit" && payload.type !== "active_page") return null;
  const normalized = normalizeUrl(payload.url);
  return normalized.isValid ? normalized.cleanUrl : payload.url;
}

/** A durable, extension-scoped inbox. The HTTP subscriber only ever appends here. */
export function enqueueBrowserPayload(sdk: ShaleSDK, payload: BrowserIngestPayload): number {
  const queue = sdk.state.getJson<QueuedBrowserPayload[]>(QUEUE_KEY) ?? [];
  const compacted = compactPayload(payload);
  const key = pageQueueKey(compacted);
  if (key) {
    const existingIndex = queue.findIndex((item) => pageQueueKey(item.payload) === key);
    if (existingIndex >= 0) {
      // Keep one pending capture per canonical page. The newest DOM material
      // and timestamp replace older retries without growing extension_state.
      queue[existingIndex] = {
        ...queue[existingIndex],
        receivedAt: Date.now(),
        payload: compacted,
      };
      sdk.state.setJson(QUEUE_KEY, queue);
      return queue.length;
    }
  }
  queue.push({ id: crypto.randomUUID(), receivedAt: Date.now(), payload: compacted });
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
