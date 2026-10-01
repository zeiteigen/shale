import { expect, it } from "bun:test";
import { createExtensionSDK, createMessageBus } from "../sdk";
import { setup } from "../extensions/process-image/setup";
import { createTestDatabase } from "./fixtures/database";

it("propagates a file message timeout to the in-flight vision transport", async () => {
  const database = createTestDatabase();
  let aborted = false;
  let transportStarted = false;
  const sdk = createExtensionSDK("process-image", {
    database,
    messageBus: createMessageBus(),
    models: {
      connection: { baseUrl: "https://models.test.invalid/v1", maxRetries: 0 },
      chat: { fetchFn: async (_url: any, init: any) => new Promise<Response>((_resolve, reject) => {
        transportStarted = true;
        init.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Cancelled", "AbortError"));
        }, { once: true });
      }) },
    },
  });
  try {
    await setup(sdk);
    await expect(sdk.messages.request("file:process", {
      filePath: "https://example.com/chart.png",
      options: { deferEmbedding: true },
    }, { timeoutMs: 30 })).rejects.toThrow("timed out");
    expect(transportStarted).toBe(true);
    expect(aborted).toBe(true);
  } finally {
    sdk.messages.clear();
    database.close();
  }
});
