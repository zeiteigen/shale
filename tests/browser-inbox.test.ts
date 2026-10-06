import { expect, it } from "bun:test";
import { createExtensionSDK } from "../sdk";
import { createTestDatabase } from "./fixtures/database";
import { enqueueBrowserPayload, getQueuedBrowserPayloads, acknowledgeQueuedBrowserPayloads } from "../extensions/browser/ingest-queue";

it("retains captures received for an in-flight URL until their own revision is acknowledged", () => {
  const database = createTestDatabase();
  const sdk = createExtensionSDK("browser", { database });
  const page = { type: "page_visit" as const, url: "https://example.com", title: "Page", textContent: "old capture" };
  try {
    enqueueBrowserPayload(sdk, page);
    const snapshot = getQueuedBrowserPayloads(sdk);
    enqueueBrowserPayload(sdk, { ...page, textContent: "new capture" });
    enqueueBrowserPayload(sdk, { ...page, url: "https://another.example" });
    acknowledgeQueuedBrowserPayloads(sdk, snapshot.map((item) => item.id));
    const current = getQueuedBrowserPayloads(sdk);
    expect(current).toHaveLength(2);
    const newer = current.find(item => (item.payload as any).textContent === "new capture")!;
    expect(newer).toBeDefined();
    acknowledgeQueuedBrowserPayloads(sdk, [newer.id]);
    expect(getQueuedBrowserPayloads(sdk)).toHaveLength(1);
  } finally {
    database.close();
  }
});
