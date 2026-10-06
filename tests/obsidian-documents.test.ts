import { afterEach, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareVault, finalizeVault, processVault, run, parseDocumentFile } from "../extensions/obsidian";
import { findDocumentFiles } from "../extensions/obsidian/document-files";
import { documentCheckpointId, documentWatermarkKey } from "../extensions/obsidian/document-vault";
import { run as recover } from "../extensions/obsidian/recover";
import { setup as setupDocument } from "../extensions/process-document/setup";
import { obsidianDocumentFixture } from "./fixtures/obsidian-documents";

const fixtures: Awaited<ReturnType<typeof obsidianDocumentFixture>>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
async function fixture(register = true) { const result = await obsidianDocumentFixture(register); fixtures.push(result); return result; }

it("processes documents across all configured vaults before any embeddings, with isolated graph identities", async () => {
  const { sdk, database, vaultA, vaultB, files, settings, events } = await fixture();
  settings({ includeImages: true, expandAtomicNotes: true });
  for (const vault of [vaultA, vaultB]) {
    copyFileSync(files.docx, join(vault.path, basename(files.docx)));
    copyFileSync(files.pdf, join(vault.path, "paper.pdf"));
    writeFileSync(join(vault.path, "Overview.md"), "![[paper.pdf#page=2|Paper]]\n[[report with spaces.docx|Report]]\n[Report](report%20with%20spaces.docx)\n![[diagram.png]]");
    writeFileSync(join(vault.path, "diagram.png"), "image fixture");
  }
  const results = await run(sdk);
  expect(results.map(result => result.documentsProcessed)).toEqual([2, 2]);
  expect(results.map(result => result.notesProcessed)).toEqual([1, 1]);
  expect(results.map(result => result.imagesProcessed)).toEqual([1, 1]);
  const firstEmbedding = events.findIndex(event => event.role === "embedding");
  expect(events.slice(0, firstEmbedding).filter(event => event.role === "chat")).toHaveLength(6);
  expect(events.slice(firstEmbedding).every(event => event.role === "embedding")).toBe(true);
  expect(sdk.getCheckpoints()).toHaveLength(0);
  expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sources WHERE type='document' AND origin='obsidian'").get()!.count).toBe(4);
  const reports = sdk.graph.entities.resolve("Research report", undefined, "knowledge");
  expect(reports).toHaveLength(2);
  const memberships = reports.map(entity => sdk.graph.claims.list({ subject: entity.id, predicate: "IN_VAULT" })[0]);
  expect(memberships[0].object).not.toBe(memberships[1].object);
  expect(reports.every(entity => entity.type === "Document" && entity.namespace === "knowledge")).toBe(true);
  const notes = sdk.graph.entities.resolve("Overview", undefined, "knowledge");
  for (const note of notes) {
    const references = sdk.graph.claims.list({ subject: note.id, predicate: "REFERENCES" });
    expect(references).toHaveLength(3);
    expect(references.every(reference => reference.qualifiers?.resolved === true)).toBe(true);
    const embed = references.find(reference => reference.qualifiers?.embedded === true)!;
    expect(embed.qualifiers?.heading).toBe("page=2");
    expect(sdk.graph.evidence.list(embed.id)[0].quote).toBe("![[paper.pdf#page=2|Paper]]");
    const noteVault = sdk.graph.claims.list({ subject: note.id, predicate: "IN_VAULT" })[0].object;
    for (const reference of references) expect(sdk.graph.claims.list({ subject: reference.object!, predicate: "IN_VAULT" })[0].object).toBe(noteVault);
  }
  const locations = sdk.graph.claims.list({ predicate: "CHUNK_LOCATION" });
  expect(locations.some(claim => (claim.value as Record<string, unknown>).pageNumber === 2)).toBe(true);
  const summaries = sdk.graph.claims.list({ predicate: "DOCUMENT_SUMMARY" });
  expect(summaries).toHaveLength(4);
  expect(summaries.every(claim => claim.status === "proposed")).toBe(true);
  events.length = 0;
  expect((await run(sdk)).every(result => result.documentsProcessed === 0 && result.notesProcessed === 0)).toBe(true);
  expect(events).toHaveLength(0);
});

it("backfills older attachments independently of existing note watermarks and catches later document updates", async () => {
  const { sdk, vaultA, files } = await fixture();
  const path = join(vaultA.path, "paper.pdf");
  copyFileSync(files.pdf, path);
  utimesSync(path, 100, 100);
  sdk.state.setWatermark("500000", `vault:${vaultA.path}:mtime`);
  const first = await processVault(vaultA, sdk);
  expect(first.documentsProcessed).toBe(1);
  expect(first.documentWatermarkAdvancedTo).toBe(100000);
  expect(sdk.state.getWatermark(documentWatermarkKey(vaultA.path))).toBe("100000");
  expect(sdk.state.getWatermark(`vault:${vaultA.path}:mtime`)).toBe("500000");
  utimesSync(path, 200, 200);
  expect((await processVault(vaultA, sdk)).documentsProcessed).toBe(1);
  expect(sdk.state.getWatermark(documentWatermarkKey(vaultA.path))).toBe("200000");
});

it("honors document settings and hidden/ignored directories without double-processing Markdown", async () => {
  const { sdk, vaultA, settings } = await fixture();
  for (const folder of ["attachments", ".trash", "Archive"]) {
    mkdirSync(join(vaultA.path, folder));
    writeFileSync(join(vaultA.path, folder, "report.TXT"), "Document evidence");
  }
  writeFileSync(join(vaultA.path, "Note.md"), "A note.");
  expect(findDocumentFiles(vaultA.path, ["archive"], [".TXT", "md"])).toEqual([join(vaultA.path, "attachments", "report.TXT")]);
  settings({ includeDocuments: false, includeMarkdown: false });
  expect((await prepareVault(vaultA, sdk)).parsedDocuments).toHaveLength(0);
  expect(sdk.state.getWatermark(documentWatermarkKey(vaultA.path))).toBeNull();
  settings({ documentExtensions: ["txt", "md"], ignoredDirectories: ["archive"] });
  const prepared = await prepareVault(vaultA, sdk);
  expect(prepared.parsedNotes).toHaveLength(1);
  expect(prepared.parsedDocuments).toHaveLength(1);
  const result = await finalizeVault(prepared, sdk);
  expect(result.documentsProcessed).toBe(1);
  expect(result.notesProcessed).toBe(1);
});

it("retains cursors when the document service is missing and resumes after it is registered", async () => {
  const { sdk, documentSDK, vaultA, files } = await fixture(false);
  copyFileSync(files.pdf, join(vaultA.path, "paper.pdf"));
  const prepared = await prepareVault(vaultA, sdk);
  expect(prepared.preparationFailed).toBe(true);
  await expect(finalizeVault(prepared, sdk)).rejects.toThrow("watermark retained");
  expect(sdk.state.getWatermark(documentWatermarkKey(vaultA.path))).toBeNull();
  await setupDocument(documentSDK);
  expect((await processVault(vaultA, sdk)).documentsProcessed).toBe(1);
});

it("keeps successful documents when another file fails, and prevents recovery from skipping the failed file", async () => {
  const { sdk, vaultA, files, database } = await fixture();
  copyFileSync(files.docx, join(vaultA.path, "good.docx"));
  writeFileSync(join(vaultA.path, "bad.pdf"), "not a PDF");
  const prepared = await prepareVault(vaultA, sdk);
  expect(prepared.parsedDocuments).toHaveLength(1);
  expect(prepared.preparationFailed).toBe(true);
  await expect(finalizeVault(prepared, sdk)).rejects.toThrow("watermark retained");
  expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sources WHERE type='document'").get()!.count).toBe(1);
  await recover(sdk);
  expect(sdk.state.getWatermark(documentWatermarkKey(vaultA.path))).toBeNull();
  copyFileSync(files.pdf, join(vaultA.path, "bad.pdf"));
  expect((await processVault(vaultA, sdk)).documentsProcessed).toBe(2);
});

it("reuses prepared document checkpoints and recovers failed embeddings without another parser or chat call", async () => {
  const { sdk, documentSDK, vaultA, files, database, failEmbeddings, events, settings } = await fixture();
  const path = join(vaultA.path, "paper.pdf");
  copyFileSync(files.pdf, path);
  const prepared = await prepareVault(vaultA, sdk);
  const chats = events.filter(event => event.role === "chat").length;
  await prepareVault(vaultA, sdk);
  expect(events.filter(event => event.role === "chat")).toHaveLength(chats);
  failEmbeddings(true);
  await expect(finalizeVault(prepared, sdk)).rejects.toThrow("watermark retained");
  expect(sdk.checkpoint.get(documentCheckpointId(path))).toBeTruthy();
  await expect(recover(sdk)).rejects.toThrow("recovery failed");
  expect(database.query("SELECT id FROM sources WHERE uri=?").get(pathToFileURL(path).href)).toBeNull();
  expect(sdk.state.getWatermark(documentWatermarkKey(vaultA.path))).toBeNull();
  documentSDK.messages.clear();
  settings({ namespace: "changed-after-crash" });
  failEmbeddings(false);
  const recovered = await recover(sdk);
  expect(recovered.recoveredDocuments).toBe(1);
  expect(events.filter(event => event.role === "chat")).toHaveLength(chats);
  expect(sdk.getCheckpoints()).toHaveLength(0);
  expect(sdk.graph.claims.list({ predicate: "DOCUMENT_SUMMARY" })[0].namespace).toBe("knowledge");
  expect(sdk.state.getWatermark(documentWatermarkKey(vaultA.path))).toBe(String(prepared.maxDocumentMtime));
});

it("rolls back document sources and checkpoints together when graph writing fails", async () => {
  const { sdk, documentSDK, vaultA, files, database } = await fixture();
  const path = join(vaultA.path, "paper.pdf");
  copyFileSync(files.pdf, path);
  const prepared = await prepareVault(vaultA, sdk);
  database.run("CREATE TRIGGER reject_document_claim BEFORE INSERT ON graph_claims WHEN NEW.predicate='DOCUMENT_METADATA' BEGIN SELECT RAISE(ABORT, 'Graph write failed'); END");
  await expect(finalizeVault(prepared, sdk)).rejects.toThrow("watermark retained");
  expect(database.query("SELECT id FROM sources WHERE uri=?").get(pathToFileURL(path).href)).toBeNull();
  expect(sdk.checkpoint.get(documentCheckpointId(path))).toBeTruthy();
  database.run("DROP TRIGGER reject_document_claim");
  documentSDK.messages.clear();
  expect((await recover(sdk)).recoveredDocuments).toBe(1);
  expect(sdk.checkpoint.get(documentCheckpointId(path))).toBeNull();
});

it("leaves missing and ambiguous document references scoped to their owning note", async () => {
  const { sdk, vaultA, files } = await fixture();
  for (const directory of ["one", "two"]) {
    mkdirSync(join(vaultA.path, directory));
    copyFileSync(files.pdf, join(vaultA.path, directory, "shared.pdf"));
  }
  writeFileSync(join(vaultA.path, "Overview.md"), "![[shared.pdf#page=1]]\n[[missing.docx]]\n[[one/shared.pdf]]");
  await processVault(vaultA, sdk);
  const note = sdk.graph.entities.resolve("Overview")[0];
  const references = sdk.graph.claims.list({ subject: note.id, predicate: "REFERENCES" });
  expect(references.filter(reference => !reference.qualifiers?.resolved)).toHaveLength(2);
  expect(references.filter(reference => reference.qualifiers?.resolved)).toHaveLength(1);
  expect(references.filter(reference => !reference.qualifiers?.resolved).every(reference => sdk.graph.entities.get(reference.object!).type === "DocumentReference")).toBe(true);
});

it("rescans older unfinished documents after recovering an interrupted preparation without a batch checkpoint", async () => {
  const { sdk, vaultA, files } = await fixture();
  const older = join(vaultA.path, "unfinished.pdf"), newer = join(vaultA.path, "recovered.pdf");
  copyFileSync(files.pdf, older);
  copyFileSync(files.pdf, newer);
  utimesSync(older, 100, 100);
  utimesSync(newer, 200, 200);
  sdk.state.setWatermark("50000", documentWatermarkKey(vaultA.path));
  const parsedDocument = await parseDocumentFile(newer, sdk, "knowledge");
  sdk.saveCheckpoint({ type: "document_analysis", vault: vaultA, namespace: "knowledge", filePath: newer, mtime: 200000, parsedDocument }, { id: documentCheckpointId(newer) });
  expect((await recover(sdk)).recoveredDocuments).toBe(1);
  expect(sdk.state.getWatermark(documentWatermarkKey(vaultA.path))).toBe("50000");
  const prepared = await prepareVault(vaultA, sdk);
  expect(prepared.parsedDocuments.map(document => document.filePath)).toContain(older);
});

it("invalidates prior document knowledge on binary changes even when extracted text and summaries stay the same", async () => {
  const { sdk, vaultA, files, database } = await fixture();
  const path = join(vaultA.path, "paper.pdf");
  copyFileSync(files.pdf, path);
  await processVault(vaultA, sdk, true);
  const previous = sdk.graph.claims.list({ predicate: "DOCUMENT_SUMMARY" })[0];
  const source = database.query<{ id: string; hash: string }, [string]>("SELECT id,hash FROM sources WHERE uri=?").get(pathToFileURL(path).href)!;
  // A trailing PDF comment changes bytes while retaining identical parsed content.
  writeFileSync(path, "\n% Updated attachment metadata\n", { flag: "a" });
  await processVault(vaultA, sdk, true);
  const updated = database.query<{ id: string; hash: string }, [string]>("SELECT id,hash FROM sources WHERE uri=?").get(pathToFileURL(path).href)!;
  expect(updated.id).toBe(source.id);
  expect(updated.hash).not.toBe(source.hash);
  expect(sdk.graph.claims.get(previous.id).status).toBe("stale");
  const current = sdk.graph.claims.list({ predicate: "DOCUMENT_SUMMARY", statuses: ["proposed"] })[0];
  expect(current.subject).toBe(previous.subject);
  expect(current.value).toBe(previous.value);
});

it("embeds long documents in bounded groups and commits every chunk", async () => {
  const { sdk, documentSDK, vaultA, events, database } = await fixture();
  writeFileSync(join(documentSDK.extensionDir!, "settings.json"), JSON.stringify({ chunkSize: 100, summarizeDocuments: false }));
  writeFileSync(join(vaultA.path, "long.txt"), "Evidence about local retrieval. ".repeat(500));
  const result = await processVault(vaultA, sdk);
  const groups = events.filter(event => event.role === "embedding");
  expect(groups.length).toBeGreaterThan(1);
  expect(groups.every(event => event.body.input.length <= 64)).toBe(true);
  expect(groups.reduce((sum, event) => sum + event.body.input.length, 0)).toBe(result.chunksCreated);
  expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM chunks").get()!.count).toBe(result.chunksCreated);
  expect(result.documentsProcessed).toBe(1);
});
