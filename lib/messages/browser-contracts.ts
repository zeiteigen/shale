export interface BrowserQuery {
  query?: string;
  collectorId?: string;
  sessionId?: string;
  threadId?: string;
  topic?: string;
  goal?: string;
  from?: number;
  to?: number;
  domain?: string;
  quality?: "full" | "partial" | "metadata";
  limit?: number;
}
export interface BrowserQueryResult {
  pages: Array<{
    sourceId: string;
    title: string;
    url: string;
    passage: string;
    locator: string | null;
    headingPath: string[];
    quality: string;
    captureOrigin?: string;
    rank: number;
  }>;
  sessions: Array<{
    sessionId: string;
    collectorId: string;
    startTime: number;
    endTime: number;
    title: string;
    summary: string;
  }>;
  threads: Array<{
    threadId: string;
    label: string;
    goal: string | null;
    topics: string[];
  }>;
}
export interface BrowserChannelDefinitions {
  "browser:query": {
    type: "request";
    request: BrowserQuery;
    response: BrowserQueryResult;
  };
  "browser:policy": {
    type: "request";
    request: Record<string, never>;
    response: {
      protocolVersion: 1;
      excludeDomains: string[];
      excludePatterns: string[];
      excludePrivateBrowsing: boolean;
      sessionInactivityMinutes: number;
    };
  };
}
