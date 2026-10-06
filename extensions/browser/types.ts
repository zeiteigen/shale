import type { BrowserExtensionSettings } from "./settings.types";
import type { WebPageParseResponse } from "../../lib/messages/web-contracts";
/**
 * Type definitions for the Shale Browser Ingestion Extension.
 */

export type {
  PageVisitPayload,
  HistoryItemPayload,
  HistoryBatchPayload,
  BookmarkItemPayload,
  BookmarksBatchPayload,
  SessionSnapshotPayload,
  TabsBatchPayload,
  BrowserPingPayload,
  BrowserIngestPayload,
} from "../../lib/browser-contract";
import type {
  BrowserRecordIdentity as importIdentity,
  PageVisitPayload,
  BrowserIngestPayload,
} from "../../lib/browser-contract";
export interface PreparedPageData {
  jobId?: string;
  contentKey?: string;
  indexedHash?: string;
  canonicalSourceId?: string;
  reused?: boolean;
  settings?: Partial<BrowserExtensionSettings>;
  sessionUpdate?: Awaited<
    ReturnType<typeof import("./session-manager").recordSessionVisit>
  > | null;
  pageData: WebPageData;
  analysis: LLMPageAnalysis;
  cleanUrl: string;
  domain: string;
  checkpointId: string;
  namespace: string;
  parser?: WebPageParseResponse;
  parsedChunks?: string[];
  contextualSummary?: string;
  imageChunks?: Array<{
    text_content: string;
    chunk_type: "verbatim" | "synthetic";
  }>;
}

export interface PreparedSessionData {
  settings?: Partial<BrowserExtensionSettings>;
  sessionId: string;
  startTime: number;
  endTime: number;
  visits: SessionVisitRecord[];
  synthesis: LLMSessionAnalysis;
  checkpointId: string;
  namespace: string;
  activityHash?: string;
  collectorId?: string;
  boundaryReason?: string;
  threads?: import("./context-builder").ResearchThread[];
}

export interface WebPageData extends importIdentity {
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
  capturedAt?: number;
  tabId?: number;
  windowId?: number;
  openerTabId?: number;
  transitionType?: string;
  recordInSession?: boolean;
  sessionId?: string;
}

export interface LLMPageAnalysis {
  method?: string;
  model?: string;
  summary: string;
  topics: string[];
  category: string;
}

export interface LLMSessionAnalysis {
  method?: string;
  model?: string;
  sessionTitle: string;
  summary: string;
  topics: string[];
  dominantDomains: string[];
}

export interface SessionVisitRecord {
  kind?: string;
  browserInstanceId?: string;
  url: string;
  title: string;
  domain: string;
  visitedAt: number;
  tabId?: number;
  windowId?: number;
  openerTabId?: number;
  transitionType?: string;
  pageSourceId?: string;
  eventId?: string;
  collectorId?: string;
  sequence?: number;
  documentId?: string;
  summary?: string;
  topics?: string[];
  goal?: string;
  tabGroup?: string;
  durationMs?: number;
  attended?: boolean;
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
