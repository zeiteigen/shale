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
  const post = (payload: string, contentType = "application/json") =>
    fetch(url, { method: "POST", headers: { "Content-Type": contentType }, body: payload });
  try {
    const accepted = await post(JSON.stringify(body));
    expect(accepted.status).toBe(202);
    expect(getQueuedBrowserPayloads(sdk)).toHaveLength(1);
    const unknown = await post(JSON.stringify({ ...body, target_processor: "missing" }));
    expect(unknown.status).toBe(404);
    expect((await post("{")).status).toBe(400);
    // A page's CORS-simple POST (no preflight) is refused before the body is read.
    expect((await post(JSON.stringify(body), "text/plain;charset=UTF-8")).status).toBe(415);
    expect((await fetch(url, { method: "POST", body: JSON.stringify(body) })).status).toBe(415);
    expect((await fetch(url)).status).toBe(405);
    expect(getQueuedBrowserPayloads(sdk)).toHaveLength(1);
  } finally {
    server.stop(true);
    database.close();
  }
});
