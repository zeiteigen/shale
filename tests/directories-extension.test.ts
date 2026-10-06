import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createExtensionSDK, createMessageBus, type ShaleSDK } from "../sdk";
import { run } from "../extensions/directories";
import { run as recover } from "../extensions/directories/recover";
import { fileStateKey } from "../extensions/directories/file-state";
import { isTExtensionManifest } from "../lib/extension";
import manifest from "../extensions/directories/manifest.json";
import { createTestDatabase } from "./fixtures/database";
import { setup as setupDocuments } from "../extensions/process-document/setup";
import { setup as setupImages } from "../extensions/process-image/setup";

let directory: string;
let database: ReturnType<typeof createTestDatabase>;
let sdk: ShaleSDK;
let calls: string[];
let failFiles: Set<string>;
let failEmbedding: boolean;
let embeddings: number[];
let onParse: ((filePath: string) => void) | undefined;
let onEmbed: (() => void) | undefined;
let parserGate: Promise<void> | undefined;

function configure(settings: Record<string, unknown>) {
  writeFileSync(join(directory, "settings.json"), JSON.stringify(settings));
}

function sourceCount() {
  return database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sources").get()!.count;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "shale-directories-"));
  database = createTestDatabase();
  sdk = createExtensionSDK("directories", { database, messageBus: createMessageBus(), extensionDir: directory });
  calls = [];
  failFiles = new Set();
  failEmbedding = false;
  embeddings = [1, 0, 0, 0];
  onParse = undefined;
  onEmbed = undefined;
  parserGate = undefined;
  sdk.logger.log = () => {};
  sdk.logger.error = () => {};
  sdk.embed = (async (texts: string[]) => {
    calls.push(`embed:${texts.length}`);
    if (failEmbedding) throw new Error("Embedding unavailable");
    onEmbed?.();
    return texts.map(() => embeddings.slice());
  }) as typeof sdk.embed;
  sdk.messages.handle("file:can-process", async ({ filePath }) => ({
    canProcess: /\.(md|txt|png)$/i.test(filePath), supportedBy: "fixture-processor",
  }), { name: "fixture-processor" });
  sdk.messages.handle("file:process", async ({ filePath, options }) => {
    expect(options?.deferEmbedding).toBe(true);
    calls.push(`chat:${filePath}`);
    onParse?.(filePath!);
    await parserGate;
    if (failFiles.has(filePath!)) throw new Error("Parser unavailable");
    return { success: true, filePath: filePath!, fileType: filePath!.endsWith(".png") ? "image" : "document",
      title: basename(filePath!), uri: `file://${filePath}`, chunks: [
        { chunk_index: 0, chunk_type: "verbatim", text_content: `Extracted ${filePath}` },
        { chunk_index: 1, chunk_type: "synthetic", text_content: "Summary" },
      ], entities: [{ name: basename(filePath!), type: "Document" }], edges: [],
      knowledge: [{ predicate: "SUMMARY", value: "Summary", chunkIndex: 1, status: "proposed", method: "fixture" }],
    };
  }, { name: "fixture-processor" });
});

afterEach(() => {
  sdk.messages.clear();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("directory ingestion", () => {
  it("has an auto-discoverable manifest and leaves an empty selection idle", async () => {
    expect(isTExtensionManifest(manifest)).toBe(true);
    configure({ directories: [] });
    expect(await run(sdk)).toEqual([]);
    expect(sourceCount()).toBe(0);
    expect(calls).toEqual([]);
  });

  it("prepares every selected root before bounded embedding and commits graph evidence", async () => {
    const roots = [join(directory, "first"), join(directory, "second")];
    roots.forEach(root => { mkdirSync(root); writeFileSync(join(root, "shared # note.md"), "Notes"); });
    configure({ directories: roots, embeddingBatchSize: 1, namespace: "research" });
    const events: string[] = [];
    sdk.messages.on("source:ingested", event => { events.push(event.uri); });
    const results = await run(sdk);
    expect(results.map(result => result.filesProcessed)).toEqual([1, 1]);
    expect(calls.slice(0, 2).every(call => call.startsWith("chat:"))).toBe(true);
    expect(calls.slice(2)).toEqual(["embed:1", "embed:1", "embed:1", "embed:1"]);
    expect(sourceCount()).toBe(2);
    expect(events.sort()).toEqual(roots.map(root => pathToFileURL(join(root, "shared # note.md")).href).sort());
    expect(database.query("SELECT 1 FROM sources WHERE origin='directories'").get()).toBeTruthy();
    expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM entities WHERE namespace='research' AND type='Document'").get()!.count).toBe(2);
    expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM edges WHERE relation='IN_DIRECTORY'").get()!.count).toBe(2);
    expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM chunk_entities").get()!.count).toBe(4);
    expect(database.query("SELECT 1 FROM graph_claims WHERE predicate='SUMMARY' AND status='proposed'").get()).toBeTruthy();
    expect(sdk.hasCheckpoints()).toBe(false);
  });

  it("skips unchanged files, detects copied older files and updates sources without duplicates", async () => {
    const root = join(directory, "notes"); mkdirSync(root);
    const first = join(root, "first.md"); writeFileSync(first, "Original");
    configure({ directories: [root] });
    await run(sdk);
    const sourceId = database.query<{ id: string }, []>("SELECT id FROM sources").get()!.id;
    calls.length = 0;
    expect((await run(sdk))[0].filesSkipped).toBe(1);
    expect(calls).toHaveLength(0);
    const older = join(root, "older.txt"); writeFileSync(older, "Copied old file"); utimesSync(older, 100, 100);
    expect((await run(sdk))[0].filesProcessed).toBe(1);
    writeFileSync(first, "Updated material");
    expect((await run(sdk))[0].filesProcessed).toBe(1);
    expect(database.query<{ id: string }, [string]>("SELECT id FROM sources WHERE uri=?").get(pathToFileURL(first).href)!.id).toBe(sourceId);
    expect(sourceCount()).toBe(2);
    expect((await run(sdk, true))[0].filesProcessed).toBe(2);
  });

  it("deduplicates overlapping roots and honors exclusions, recursion, and hot settings", async () => {
    const root = join(directory, "notes"); const nested = join(root, "nested"); mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "visible.md"), "Visible");
    writeFileSync(join(root, ".hidden.md"), "Hidden");
    writeFileSync(join(root, "image.png"), "Image");
    writeFileSync(join(nested, "child.md"), "Child");
    for (const name of [".private", "node_modules", "Archive"]) {
      mkdirSync(join(root, name)); writeFileSync(join(root, name, "skip.md"), "Ignored");
    }
    symlinkSync(root, join(root, "loop"));
    symlinkSync(join(root, "visible.md"), join(root, "linked.md"));
    configure({ directories: [root, nested, root], fileExtensions: [".MD"], ignoredDirectories: ["node_modules", "archive"] });
    const results = await run(sdk);
    expect(results.reduce((sum, result) => sum + result.filesProcessed, 0)).toBe(2);
    expect(sourceCount()).toBe(2);
    configure({ directories: [root], recursive: false, ignoreHidden: false, fileExtensions: ["md"] });
    expect((await run(sdk))[0].filesProcessed).toBe(1);
    expect(sourceCount()).toBe(3);
    configure({ directories: [root], recursive: false, fileExtensions: ["png"] });
    expect((await run(sdk))[0].filesProcessed).toBe(1);
    expect(sourceCount()).toBe(4);
  });

  it("continues after invalid roots and parser failures without losing older unfinished files", async () => {
    const root = join(directory, "notes"); mkdirSync(root);
    const older = join(root, "older.md"); const newer = join(root, "newer.md");
    writeFileSync(older, "Old"); writeFileSync(newer, "New"); utimesSync(older, 100, 100); utimesSync(newer, 200, 200);
    failFiles.add(older);
    configure({ directories: [join(directory, "missing"), root] });
    const results = await run(sdk);
    expect(results[0].errors).toHaveLength(1);
    expect(results[1].errors).toHaveLength(1);
    expect(results[1].filesProcessed).toBe(1);
    expect(sdk.state.getWatermark(fileStateKey("directories", older))).toBeNull();
    failFiles.clear(); calls.length = 0;
    expect((await run(sdk))[1].filesProcessed).toBe(1);
    expect(calls.filter(call => call.startsWith("chat:"))).toEqual([`chat:${older}`]);
    expect(sourceCount()).toBe(2);
  });

  it("keeps prepared checkpoints after embedding failure and recovers without chat calls", async () => {
    const root = join(directory, "notes"); mkdirSync(root);
    const file = join(root, "recover.md"); writeFileSync(file, "Recovery");
    configure({ directories: [root], embeddingBatchSize: 1 });
    failEmbedding = true;
    expect((await run(sdk))[0].errors).toHaveLength(1);
    expect(sdk.hasCheckpoints()).toBe(true);
    expect(sourceCount()).toBe(0);
    expect(sdk.state.getWatermark(fileStateKey("directories", file))).toBeNull();
    await expect(recover(sdk)).rejects.toThrow("Directory recovery failed");
    failEmbedding = false; calls.length = 0;
    expect(await recover(sdk)).toEqual({ recoveredFiles: 1, discardedFiles: 0 });
    expect(calls).toEqual(["embed:1", "embed:1"]);
    expect(sourceCount()).toBe(1);
    expect(sdk.hasCheckpoints()).toBe(false);
    expect(sdk.state.getWatermark(fileStateKey("directories", file))).toBeTruthy();
  });

  it("reuses checkpoints on a manual scan and rolls back graph and state on invalid vectors", async () => {
    const root = join(directory, "notes"); mkdirSync(root);
    const file = join(root, "retry.md"); writeFileSync(file, "Retry");
    configure({ directories: [root] });
    embeddings = [1, 0];
    expect((await run(sdk))[0].errors).toHaveLength(1);
    expect(sourceCount()).toBe(0);
    expect(database.query("SELECT 1 FROM entities").get()).toBeNull();
    expect(sdk.state.getWatermark(fileStateKey("directories", file))).toBeNull();
    expect(sdk.getCheckpoints()).toHaveLength(1);
    embeddings = [1, 0, 0, 0]; calls.length = 0;
    expect((await run(sdk))[0].filesProcessed).toBe(1);
    expect(calls).toEqual(["embed:2"]);
  });

  it("discards stale and removed-file checkpoints and rescans modified files", async () => {
    const root = join(directory, "notes"); mkdirSync(root);
    const changed = join(root, "changed.md"); const removed = join(root, "removed.md");
    writeFileSync(changed, "Old"); writeFileSync(removed, "Removed");
    configure({ directories: [root] }); failEmbedding = true;
    await run(sdk);
    writeFileSync(changed, "New material"); rmSync(removed);
    failEmbedding = false; calls.length = 0;
    expect(await recover(sdk)).toEqual({ recoveredFiles: 0, discardedFiles: 2 });
    expect(calls).toEqual([]);
    expect((await run(sdk))[0].filesProcessed).toBe(1);
  });

  it("skips unsupported files and reports oversized files without marking them complete", async () => {
    const root = join(directory, "notes"); mkdirSync(root);
    const large = join(root, "large.txt"); writeFileSync(large, "Large");
    writeFileSync(join(root, "binary.bin"), "Unsupported");
    configure({ directories: [root], fileExtensions: [], maxFileSizeMB: 0.000001 });
    const result = (await run(sdk))[0];
    expect(result.errors).toHaveLength(2);
    expect(calls).toEqual([]);
    configure({ directories: [root], fileExtensions: [] });
    const retried = (await run(sdk))[0];
    expect(retried.filesProcessed).toBe(1);
    expect(retried.filesSkipped).toBe(1);
  });

  it("does not advance a watermark when a file changes during parsing or embedding", async () => {
    const root = join(directory, "notes"); mkdirSync(root);
    const file = join(root, "changing.md"); writeFileSync(file, "Original");
    configure({ directories: [root] });
    onParse = path => writeFileSync(path, "Changed during parsing");
    expect((await run(sdk))[0].errors[0].error).toContain("changed while processing");
    expect(sdk.hasCheckpoints()).toBe(false);
    expect(sourceCount()).toBe(0);
    onParse = undefined;
    onEmbed = () => writeFileSync(file, "Changed during embedding");
    expect((await run(sdk))[0].errors[0].error).toContain("changed during embedding");
    expect(sdk.hasCheckpoints()).toBe(true);
    expect(sourceCount()).toBe(0);
    expect(sdk.state.getWatermark(fileStateKey("directories", file))).toBeNull();
    onEmbed = undefined;
    expect(await recover(sdk)).toEqual({ recoveredFiles: 0, discardedFiles: 1 });
    expect((await run(sdk))[0].filesProcessed).toBe(1);
  });

  it("guards scans and recovery from overlapping and releases the guard after completion", async () => {
    const root = join(directory, "notes"); mkdirSync(root);
    writeFileSync(join(root, "guard.md"), "Original");
    configure({ directories: [root] });
    let release!: () => void;
    let started!: () => void;
    parserGate = new Promise<void>(resolve => { release = resolve; });
    const reachedParser = new Promise<void>(resolve => { started = resolve; });
    onParse = () => started();
    const first = run(sdk);
    await reachedParser;
    try {
      await expect(run(sdk)).rejects.toThrow("already running");
      await expect(recover(sdk)).rejects.toThrow("already running");
    } finally { release(); }
    expect((await first)[0].filesProcessed).toBe(1);
    expect((await run(sdk))[0].filesSkipped).toBe(1);
  });

  it("ingests real document extraction through the installed message handlers", async () => {
    const root = join(directory, "notes"); mkdirSync(root);
    const file = join(root, "reference # 1.txt"); writeFileSync(file, "A local reference containing useful knowledge.");
    configure({ directories: [root] });
    sdk.messages.clear();
    const documentSDK = createExtensionSDK("process-document", { database, messageBus: sdk.messages.bus, extensionDir: directory });
    const imageSDK = createExtensionSDK("process-image", { database, messageBus: sdk.messages.bus, extensionDir: directory });
    try {
      await setupImages(imageSDK); await setupDocuments(documentSDK);
      const result = (await run(sdk))[0];
      expect(result.errors).toEqual([]);
      expect(result.filesProcessed).toBe(1);
      expect(database.query<{ text_content: string }, []>("SELECT text_content FROM chunks").get()!.text_content).toContain("useful knowledge");
      expect(database.query<{ uri: string }, []>("SELECT uri FROM sources").get()!.uri).toBe(pathToFileURL(file).href);
    } finally { documentSDK.messages.clear(); imageSDK.messages.clear(); }
  });
});
