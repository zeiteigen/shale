/** Shared wire contract. The Chrome validator is built from the same source. */
export const BROWSER_PROTOCOL_VERSION = 1;
export const MAX_BROWSER_BYTES = 2_000_000;
export const MAX_BROWSER_RECORDS = 100;
export interface BrowserRecordIdentity {
  recordId?: string;
  collectorId?: string;
  eventId?: string;
  sequence?: number;
  documentId?: string;
  browserInstanceId?: string;
  incognito?: boolean;
  goal?: string;
  tabGroup?: string;
  captureOrigin?: "live-dom" | "tab-metadata" | "public-fetch";
}
export interface PageBlock {
  kind:
    "heading" | "paragraph" | "list" | "table" | "code" | "quote" | "caption";
  text: string;
  locator: string;
  headingPath: string[];
  level?: number;
}
export interface ExtractionInfo {
  method: string;
  version: string;
  quality: "full" | "partial" | "metadata";
  truncated: boolean;
  originalChars: number;
  reasons: string[];
}
export interface PageVisitPayload extends BrowserRecordIdentity {
  type: "page_visit" | "active_page";
  url: string;
  title: string;
  textContent: string;
  excerpt?: string;
  favIconUrl?: string;
  author?: string;
  /** Sanitized by the server-side parser; capped by the browser connector. */
  html?: string;
  blocks?: PageBlock[];
  extraction?: ExtractionInfo;
  canonicalUrl?: string;
  links?: Array<{ url: string; text?: string; rel?: string }>;
  images?: Array<{
    url: string;
    alt?: string;
    width?: number;
    height?: number;
  }>;
  tabId?: number;
  windowId?: number;
  openerTabId?: number;
  transitionType?: string;
  /** Only true navigation events participate in browsing sessions. */
  recordInSession?: boolean;
  sessionId?: string;
  visitedAt?: number;
  capturedAt?: number;
}

export interface HistoryItemPayload extends BrowserRecordIdentity {
  id?: string;
  url: string;
  title: string;
  visitTime: number;
  visitCount?: number;
  typedCount?: number;
}

export interface HistoryBatchPayload {
  type: "history_batch";
  items: HistoryItemPayload[];
  syncedAt?: number;
}

export interface BookmarkItemPayload extends BrowserRecordIdentity {
  id: string;
  title: string;
  url?: string;
  folderPath?: string;
  parentId?: string;
  folders?: Array<{ id: string; title: string; parentId?: string }>;
  dateAdded?: number;
}

export interface BookmarksBatchPayload {
  type: "bookmarks_batch";
  items: BookmarkItemPayload[];
  syncedAt?: number;
}

export interface SessionSnapshotPayload {
  type: "session_snapshot" | "session_end";
  sessionId: string;
  startTime: number;
  endTime?: number;
  pages: {
    url: string;
    title: string;
    visitedAt: number;
    tabId?: number;
    windowId?: number;
    openerTabId?: number;
    transitionType?: string;
  }[];
}
export interface TabsBatchPayload {
  type: "tabs_batch" | "pages_batch";
  pages: PageVisitPayload[];
  syncedAt?: number;
}

export interface BrowserPingPayload {
  type: "ping";
}

export type LegacyBrowserPayload =
  | PageVisitPayload
  | TabsBatchPayload
  | HistoryBatchPayload
  | BookmarksBatchPayload
  | SessionSnapshotPayload
  | BrowserPingPayload;

export interface ActivityEventPayload extends BrowserRecordIdentity {
  navigationEventId?: string;
  type: "activity_event";
  eventId: string;
  kind:
    | "navigation"
    | "history_backfill"
    | "activation"
    | "attention"
    | "close"
    | "session_end"
    | "goal";
  url: string;
  title: string;
  visitedAt: number;
  tabId?: number;
  windowId?: number;
  openerTabId?: number;
  transitionType?: string;
  sessionId?: string;
  durationMs?: number;
  attended?: boolean;
}
export interface CatalogDeletePayload extends BrowserRecordIdentity {
  type: "catalog_delete";
  catalog: "bookmark" | "history";
  ids?: string[];
  urls?: string[];
  all?: boolean;
}
export interface PublicPageCapture extends BrowserRecordIdentity {
  type: "public_page_capture";
  url: string;
  title?: string;
}
export type BrowserRecord =
  | PublicPageCapture
  | PageVisitPayload
  | ActivityEventPayload
  | CatalogDeletePayload
  | (HistoryItemPayload & { type: "history_item" })
  | (BookmarkItemPayload & { type: "bookmark_item" });
export interface BrowserBatchPayload {
  type: "browser_batch";
  protocolVersion: 1;
  collectorId: string;
  batchId: string;
  records: BrowserRecord[];
}
export type BrowserIngestPayload =
  | LegacyBrowserPayload
  | ActivityEventPayload
  | CatalogDeletePayload
  | BrowserBatchPayload
  | PublicPageCapture;
export interface BrowserReceipt {
  protocolVersion: 1;
  collectorId: string;
  batchId: string;
  records: Array<{
    recordId: string;
    jobId: string;
    status: "received" | "duplicate" | "skipped";
    reason?: string;
  }>;
}
