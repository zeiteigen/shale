/**
 * Type definitions for the Shale Browser Ingestion Extension.
 */

export interface PageVisitPayload {
  type: "page_visit" | "active_page";
  url: string;
  title: string;
  textContent: string;
  excerpt?: string;
  favIconUrl?: string;
  author?: string;
  /** Sanitized by the server-side parser; capped by the browser connector. */
  html?: string;
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
}

export interface HistoryItemPayload {
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

export interface BookmarkItemPayload {
  id: string;
  title: string;
  url?: string;
  folderPath?: string;
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

export type BrowserIngestPayload =
  | PageVisitPayload
  | TabsBatchPayload
  | HistoryBatchPayload
  | BookmarksBatchPayload
  | SessionSnapshotPayload
  | BrowserPingPayload;

export interface PreparedPageData {
  sessionUpdate?: Awaited<
    ReturnType<typeof import("./session-manager").recordSessionVisit>
  > | null;
  pageData: WebPageData;
  analysis: LLMPageAnalysis;
  cleanUrl: string;
  domain: string;
  checkpointId: string;
  namespace: string;
  parsedChunks?: string[];
  contextualSummary?: string;
  imageChunks?: Array<{
    text_content: string;
    chunk_type: "verbatim" | "synthetic";
  }>;
}

export interface PreparedSessionData {
  sessionId: string;
  startTime: number;
  endTime: number;
  visits: SessionVisitRecord[];
  synthesis: LLMSessionAnalysis;
  checkpointId: string;
  namespace: string;
}

export interface WebPageData {
  url: string;
  cleanUrl: string;
  domain: string;
  title: string;
  textContent: string;
  excerpt: string;
  favIconUrl?: string;
  author?: string;
  links?: Array<{ url: string; text?: string; rel?: string }>;
  images?: Array<{
    url: string;
    alt?: string;
    width?: number;
    height?: number;
  }>;
  visitedAt: number;
  tabId?: number;
  windowId?: number;
  openerTabId?: number;
  transitionType?: string;
  recordInSession?: boolean;
  sessionId?: string;
}

export interface LLMPageAnalysis {
  summary: string;
  topics: string[];
  category: string;
}

export interface LLMSessionAnalysis {
  sessionTitle: string;
  summary: string;
  topics: string[];
  dominantDomains: string[];
}

export interface SessionVisitRecord {
  url: string;
  title: string;
  domain: string;
  visitedAt: number;
  tabId?: number;
  windowId?: number;
  openerTabId?: number;
  transitionType?: string;
  pageSourceId?: string;
}

export interface ActiveSessionState {
  sessionId: string;
  startTime: number;
  lastActivityTime: number;
  visits: SessionVisitRecord[];
}

export interface IngestedPageResult {
  sourceId: string;
  chunkIds: number[];
  entitiesCount: number;
  edgesCount: number;
  summary: string;
  topics: string[];
  category: string;
  sessionId?: string;
}

export interface IngestedSessionResult {
  sourceId: string;
  sessionId: string;
  title: string;
  summary: string;
  topics: string[];
  pageCount: number;
  edgesCount: number;
}
