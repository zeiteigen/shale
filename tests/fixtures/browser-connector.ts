import { createExtensionSDK, createMessageBus } from "../../sdk";
import { createTestDatabase } from "./database";
import { parseWebPage } from "../../extensions/web-page-parser/parser";
export function browserFixture() {
  const database = createTestDatabase(),
    trace: string[] = [];
  const policy: any = {
    enableLlmAnalysis: true,
    generateSessionSummaries: true,
    enableImageAnalysis: false,
    refineResearchContexts: false,
    excludeDomains: [],
    excludePatterns: [],
    excludePrivateBrowsing: true,
    sessionInactivityMinutes: 1,
    maxSessionEvents: 200,
    minContentLength: 20,
    chunkSize: 200,
    maxJobAttempts: 2,
    maxJobsPerRun: 20,
    maxSessionsPerRun: 3,
  };
  const bus = createMessageBus();
  const sdk = createExtensionSDK("browser", {
    database,
    messageBus: bus,
    models: {
      connection: {
        baseUrl: "http://localhost:11434/v1",
        maxRetries: 0,
        fetchFn: async () => {
          trace.push("chat");
          return Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "Evidence about SQLite indexes",
                    topics: ["SQLite"],
                    category: "Documentation",
                    sessionTitle: "SQLite research",
                    dominantDomains: ["example.com"],
                  }),
                },
              },
            ],
          });
        },
      },
    },
  });
  sdk.settings.getAll = () => ({ ...policy });
  sdk.settings.get = (key: string) => policy[key];
  const parser = createExtensionSDK("web-page-parser", {
    database,
    messageBus: bus,
  });
  bus.handle("web:parse", (request) => parseWebPage(parser, request), {
    name: "web-page-parser",
  });
  return { sdk, database, trace, policy };
}
const captureTime = Date.now() - 120000;
export const capture = (
  id: string,
  url = "https://example.com/sqlite",
  visitedAt = captureTime,
) => ({
  type: "page_visit" as const,
  recordId: id,
  eventId: `event:${id}`,
  url,
  title: "SQLite indexes",
  textContent:
    "SQLite supports useful database indexes for efficient queries. ".repeat(5),
  visitedAt,
  tabId: 1,
  recordInSession: false,
});
export const navigation = (
  id: string,
  time: number,
  tabId = 1,
  url = "https://example.com/sqlite",
  goal = "",
) => ({
  type: "activity_event" as const,
  recordId: id,
  eventId: id,
  kind: "navigation" as const,
  url,
  title: url,
  visitedAt: time,
  tabId,
  windowId: 1,
  sequence: time,
  documentId: id,
  goal,
});
export const batch = (
  records: unknown[],
  batchId = "batch",
  collectorId = "collector",
) => ({
  type: "browser_batch",
  protocolVersion: 1,
  collectorId,
  batchId,
  records,
});
