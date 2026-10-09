import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionSDK, createMessageBus } from "../sdk";
import { processDocumentFile, processDocumentFilesBatch, setup } from "../extensions/process-document";
import { setup as setupImage } from "../extensions/process-image/setup";
import { isTExtensionManifest } from "../lib/extension";
import manifest from "../extensions/process-document/manifest.json";
import { createTestDatabase } from "./fixtures/database";
import { writeDocumentFixtures } from "./fixtures/documents";

const directory = mkdtempSync(join(tmpdir(), "shale-document-messages-"));
const files = writeDocumentFixtures(directory);
const database = createTestDatabase();
const bus = createMessageBus();
const calls: Array<{ role: "chat"; body: any }> = [];
let failChat = false;
const sdk = createExtensionSDK("process-document", {
  namespace: "documents", database, messageBus: bus, extensionDir: directory,
  models: {
    connection: { baseUrl: "https://models.test.invalid/v1", resource: null, maxRetries: 0,
      fetchFn: async (url: RequestInfo | URL | string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ role: "chat", body });
        if (failChat) return Response.json({ error: { message: "Chat unavailable" } }, { status: 503 });
        return Response.json({ id: "summary", object: "chat.completion", model: "summary-model", choices: [{ index: 0, message: { role: "assistant", content: "The document presents evidence for local knowledge extraction." }, finish_reason: "stop" }] });
      } },
    chat: { model: "summary-model" },
  },
});
const imageSDK = createExtensionSDK("process-image", { database, messageBus: bus, extensionDir: directory });
const caller = createExtensionSDK("caller", { database, messageBus: bus });

function settings(value: Record<string, unknown>) {
  writeFileSync(join(directory, "settings.json"), JSON.stringify(value));
}
beforeEach(() => { calls.length = 0; failChat = false; settings({}); });
afterEach(() => { sdk.messages.clear(); imageSDK.messages.clear(); });
afterAll(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

describe("process-document extension", () => {
  it("has a valid auto-discovery manifest", () => { expect(isTExtensionManifest(manifest)).toBe(true); });

  it("routes documents and image capabilities correctly with both extensions loaded", async () => {
    await setupImage(imageSDK);
    await setup(sdk);
    const capability = await caller.messages.request("file:can-process", { filePath: files.pdf });
    expect(capability.supportedBy).toBe("process-document");
    const image = await caller.messages.request("file:can-process", { filePath: "diagram.png" });
    expect(image.supportedBy).toBe("process-image");
    const unsupported = await caller.messages.request("file:can-process", { filePath: "legacy.doc" }, { target: "process-document" });
    expect(unsupported.canProcess).toBe(false);
    expect(unsupported.supportedBy).toBeUndefined();
    const result = await caller.messages.request("file:process", { filePath: files.docx, contextEntity: "Research vault", options: { namespace: "research" } });
    expect(result.success).toBe(true);
    expect(result.title).toBe("Research report");
    expect(result.entities[0].namespace).toBe("research");
    expect(result.edges).toEqual([{ source: "Research report", target: "Research vault", relation: "CONTAINED_IN" }]);
    expect(calls).toHaveLength(0);
  });

  it("supports bulk channels and file:process batch compatibility", async () => {
    await setup(sdk);
    const capability = await caller.messages.request("files:can-process", { filePaths: [files.pdf, files.pptx] });
    expect(capability.canProcessAll).toBe(true);
    const partial = await caller.messages.request("files:can-process", { filePaths: [files.docx, "image.png"] });
    expect(partial.canProcessAll).toBe(false);
    expect(partial.results[files.docx].canProcess).toBe(true);
    for (const channel of ["files:process", "file:process-batch"] as const) {
      const result = await caller.messages.request(channel, { filePaths: [files.docx, files.pptx] });
      expect(result.totalProcessed).toBe(2);
      expect(result.totalFailed).toBe(0);
    }
    const legacy = await caller.messages.request("file:process", { files: [files.docx, files.pdf] });
    expect(legacy.results).toHaveLength(2);
    expect(legacy.totalProcessed).toBe(2);
    expect(legacy.chunks.length).toBeGreaterThan(0);
  });

  it("summarizes each document and returns text chunks", async () => {
    settings({ summarizeDocuments: true, summaryMaxChars: 20 });
    const result = await processDocumentFilesBatch({ filePaths: [files.txt, files.rtf] }, sdk);
    expect(result.success).toBe(true);
    expect(calls.slice(0, 2).map(call => call.role)).toEqual(["chat", "chat"]);
    expect(calls).toHaveLength(2);
    for (const item of result.results) {
      expect(item.chunks.at(-1)?.chunk_type).toBe("synthetic");
      expect(item.chunks.at(-1)?.metadata?.inputTruncated).toBe(true);
      expect(item.knowledge?.[0].status).toBe("proposed");
      expect(item.knowledge?.[0].chunkIndex).toBe(item.chunks.length - 1);
    }
  });

  it("processes batches as text-only extraction results", async () => {
    const result = await processDocumentFilesBatch({ filePaths: [files.txt, files.rtf] }, sdk);
    expect(result.success).toBe(true);
    expect(result.results.every(item => item.chunks.length > 0 && item.chunks.every(chunk => typeof chunk.text_content === "string"))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("preserves good files and reports per-file errors without silently ingesting", async () => {
    const countBefore = database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sources").get()!.count;
    const result = await processDocumentFilesBatch({ files: [files.txt, join(directory, "missing.docx"), "legacy.doc"] }, sdk);
    expect(result.success).toBe(false);
    expect(result.totalProcessed).toBe(1);
    expect(result.totalFailed).toBe(2);
    expect(result.results.map(item => item.success)).toEqual([true, false, false]);
    expect(result.errors?.[1].error).toContain("converted");
    expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sources").get()!.count).toBe(countBefore);
  });

  it("keeps extracted text when summaries fail", async () => {
    settings({ summarizeDocuments: true });
    failChat = true;
    const summaryFailure = await processDocumentFile({ filePath: files.txt }, sdk);
    expect(summaryFailure.success).toBe(true);
    expect(summaryFailure.chunks[0].chunk_type).toBe("verbatim");
    expect(summaryFailure.metadata?.summaryError).toContain("Chat unavailable");
    expect(summaryFailure.chunks.length).toBeGreaterThan(0);
    expect(calls.every(call => call.role === "chat")).toBe(true);
  });

  it("reads changed format settings in handler predicates without re-registration", async () => {
    await setup(sdk);
    expect((await caller.messages.request("file:can-process", { filePath: files.docx }, { target: "process-document" })).canProcess).toBe(true);
    settings({ supportedExtensions: ["pdf"] });
    expect((await caller.messages.request("file:can-process", { filePath: files.docx }, { target: "process-document" })).canProcess).toBe(false);
    const disabled = await caller.messages.request("file:process", { filePath: files.docx }, { target: "process-document" });
    expect(disabled.success).toBe(false);
    expect(disabled.error).toContain("disabled");
  });

  it("propagates message cancellation and never starts subsequent model calls", async () => {
    await setup(sdk);
    await expect(caller.messages.request("files:process", { filePaths: [files.docx, files.pptx] }, { timeoutMs: 1 })).rejects.toThrow("timed out");
    await Bun.sleep(200);
    expect(calls).toHaveLength(0);
    const controller = new AbortController();
    controller.abort(new Error("Cancelled before batch"));
    await expect(processDocumentFilesBatch({ filePaths: [files.txt] }, sdk, controller.signal)).rejects.toThrow("Cancelled before batch");
  });

  it("returns a valid empty batch and rejects missing single-file input", async () => {
    const batch = await processDocumentFilesBatch({}, sdk);
    expect(batch).toEqual({ success: true, totalProcessed: 0, totalFailed: 0, results: [] });
    const single = await processDocumentFile({}, sdk);
    expect(single.success).toBe(false);
    expect(single.error).toContain("required");
  });
});
