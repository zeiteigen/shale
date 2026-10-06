import { expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createExtensionSDK, createMessageBus } from "../sdk";
import { createTestDatabase } from "./fixtures/database";
import { parseImageFile, parseImageFilesBatch } from "../extensions/obsidian/parse-image";
import { prepareVault } from "../extensions/obsidian/process-vaults";
import { processImageFilesBatch } from "../extensions/process-image/process-image";
import type { ProcessFileResponse } from "../lib/messages.types";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "image-retry-"));
  const database = createTestDatabase();
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ includeMarkdown: false, includeDocuments: false, includeImages: true }));
  const sdk = createExtensionSDK("obsidian parser", {
    database, extensionDir: directory, messageBus: createMessageBus(),
  });
  const paths = ["first.png", "second.png"].map(name => join(directory, name));
  paths.forEach(path => writeFileSync(path, "synthetic image"));
  return { directory, sdk, paths, close: () => {
    sdk.messages.clear(); database.close(); rmSync(directory, { recursive: true, force: true });
  } };
}

function result(filePath: string, success = true): ProcessFileResponse {
  return { filePath, success, fileType: "image", title: filePath.split("/").pop()!,
    uri: `file://${filePath}`, description: "Synthetic chart description",
    chunks: success ? [{ chunk_index: 0, text_content: "A chart", metadata: { origin: "vision" } }] : [],
    entities: [], edges: [], error: success ? undefined : "Vision request timed out" };
}

it("lets delegated vision work use its model deadline instead of the default bus deadline", async () => {
  const f = fixture();
  const deadlines: Array<number | undefined> = [];
  const request = f.sdk.messages.request;
  Object.defineProperty(f.sdk.messages, "request", { value: ((channel: any, payload: any, options: any) => {
    deadlines.push(options?.timeoutMs);
    // Compress the bus's normal 30 seconds to 10ms to reproduce premature expiry.
    return request(channel, payload, { ...options, timeoutMs: options?.timeoutMs ?? 10 });
  }) as typeof request });
  f.sdk.messages.handle("file:process", async req => { await delay(30); return result(req.filePath!); });
  f.sdk.messages.handle("files:process", async req => {
    await delay(30); return { success: true, totalProcessed: 2, totalFailed: 0, results: req.filePaths!.map(path => result(path)) };
  });
  try {
    expect((await parseImageFile(f.paths[0], f.sdk)).imageTitle).toBe("first.png");
    expect(await parseImageFilesBatch(f.paths, f.sdk)).toHaveLength(2);
    expect(deadlines).toEqual([0, 0]);
  } finally { f.close(); }
});

it("keeps partial image results with their correct paths and checkpoints without duplicate fallback", async () => {
  const f = fixture();
  let bulkCalls = 0, singleCalls = 0, localCalls = 0;
  f.sdk.queryLLM = (async () => { localCalls++; throw new Error("Unexpected local fallback"); }) as any;
  f.sdk.messages.handle("file:process", async req => { singleCalls++; return result(req.filePath!); });
  f.sdk.messages.handle("files:process", async () => {
    bulkCalls++;
    // Deliberately reordered; the successful second image must retain its identity.
    return { success: false, totalProcessed: 1, totalFailed: 1,
      results: [result(f.paths[1]), result(f.paths[0], false)] };
  });
  try {
    const prepared = await prepareVault({ id: "vault", name: "Vault", path: f.directory }, f.sdk);
    expect(prepared.preparationFailed).toBe(true);
    expect(prepared.parsedImages.map(image => image.filePath)).toEqual([f.paths[1]]);
    expect(f.sdk.checkpoint.get(`image_analysis:${f.paths[1]}`)).not.toBeNull();
    expect(f.sdk.checkpoint.get(`image_analysis:${f.paths[0]}`)).toBeNull();
    expect([bulkCalls, singleCalls, localCalls]).toEqual([1, 0, 0]);
  } finally { f.close(); }
});

it("leaves a failed image batch pending without retrying individual images in the same scan", async () => {
  const f = fixture();
  let singleCalls = 0;
  f.sdk.messages.handle("file:process", async req => { singleCalls++; return result(req.filePath!); });
  f.sdk.messages.handle("files:process", async () => { throw new Error("Vision transport failed"); });
  try {
    const prepared = await prepareVault({ id: "vault", name: "Vault", path: f.directory }, f.sdk);
    expect(prepared.preparationFailed).toBe(true);
    expect(prepared.parsedImages).toHaveLength(0);
    expect(singleCalls).toBe(0);
  } finally { f.close(); }
});

it("reports failed vision work instead of accepting a placeholder description as successful", async () => {
  const f = fixture();
  f.sdk.queryLLM = (async () => { throw new Error("Vision request timed out"); }) as any;
  try {
    const batch = await processImageFilesBatch({ filePaths: [f.paths[0]], options: { deferEmbedding: true } }, f.sdk);
    expect(batch.success).toBe(false);
    expect(batch.totalFailed).toBe(1);
    expect(batch.results[0].chunks).toEqual([]);
    expect(batch.results[0].error).toContain("timed out");
    await expect(parseImageFile(f.paths[0], f.sdk)).rejects.toThrow("timed out");
  } finally { f.close(); }
});
