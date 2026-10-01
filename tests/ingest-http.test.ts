import { expect, it } from "bun:test";
import { handleIngestRequest } from "../main/ingest-http";
import { subscribe } from "../extensions/browser/subscribe";
import { getQueuedBrowserPayloads } from "../extensions/browser/ingest-queue";
import { createExtensionSDK } from "../sdk";
import { createTestDatabase } from "./fixtures/database";

it("delivers the Chrome payload shape to the durable inbox and rejects bad routing", async () => {
  const database = createTestDatabase();
  const sdk = createExtensionSDK("browser", { database });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) =>
    handleIngestRequest(req, ["browser"], (item) => { void subscribe(item, sdk); }),
  });
  const url = `http://127.0.0.1:${server.port}/ingest`;
  const body = {
    target_processor: "browser",
    content: JSON.stringify({ type: "page_visit", url: "https://example.com", textContent: "Captured DOM" }),
    metadata: { connector: "chrome-extension", data_origin: "chrome", time: Date.now() },
  };
  try {
    const accepted = await fetch(url, { method: "POST", body: JSON.stringify(body) });
    expect(accepted.status).toBe(202);
    expect(getQueuedBrowserPayloads(sdk)).toHaveLength(1);
    const unknown = await fetch(url, { method: "POST", body: JSON.stringify({ ...body, target_processor: "missing" }) });
    expect(unknown.status).toBe(404);
    expect((await fetch(url, { method: "POST", body: "{" })).status).toBe(400);
    expect((await fetch(url)).status).toBe(405);
    expect(getQueuedBrowserPayloads(sdk)).toHaveLength(1);
  } finally {
    server.stop(true);
    database.close();
  }
});
