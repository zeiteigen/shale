import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionSDK, createMessageBus, type ModelProfiles } from "../../sdk";
import { setup as setupDocument } from "../../extensions/process-document/setup";
import { setup as setupImage } from "../../extensions/process-image/setup";
import { createTestDatabase } from "./database";
import { writeDocumentFixtures } from "./documents";

export async function obsidianDocumentFixture(register = true) {
  const directory = mkdtempSync(join(tmpdir(), "shale-obsidian-documents-"));
  const database = createTestDatabase();
  const messageBus = createMessageBus();
  const events: Array<{ role: "chat" | "embedding"; body: any }> = [];
  let embeddingFailure = false;
  const models: ModelProfiles = {
    connection: {
      baseUrl: "https://models.test.invalid/v1", resource: "obsidian-document-tests", maxRetries: 0,
      fetchFn: async (url: RequestInfo | URL | string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (String(url).includes("embeddings")) {
          events.push({ role: "embedding", body });
          if (embeddingFailure) return Response.json({ error: { message: "Document embedding unavailable" } }, { status: 503 });
          return Response.json({ data: body.input.map((_: unknown, index: number) => ({ index, embedding: [1, 0, 0, 0] })) });
        }
        events.push({ role: "chat", body });
        return Response.json({ id: "summary", object: "chat.completion", model: "test-summary", choices: [{ index: 0, message: { role: "assistant", content: "This document records evidence for local knowledge extraction." }, finish_reason: "stop" }] });
      },
    },
    chat: { model: "test-summary" },
    embedding: { model: "test-embedding", dimensions: 4, padToDimensions: null },
  };
  const folder = (name: string) => { const path = join(directory, name); mkdirSync(path); return path; };
  const settingsDirectory = folder("settings");
  const documentDirectory = folder("document-settings");
  const imageDirectory = folder("image-settings");
  const vaultA = { id: "a", name: "Shared vault name", path: folder("vault-a") };
  const vaultB = { id: "b", name: "Shared vault name", path: folder("vault-b") };
  const fixtureDirectory = folder("fixtures");
  const files = writeDocumentFixtures(fixtureDirectory);
  const settings = (value: Record<string, unknown> = {}) => {
    writeFileSync(join(settingsDirectory, "settings.json"), JSON.stringify({
      namespace: "knowledge", expandAtomicNotes: false, includeImages: false,
      customVaults: [{ name: vaultA.name, path: vaultA.path }, { name: vaultB.name, path: vaultB.path }],
      ...value,
    }));
  };
  settings();
  writeFileSync(join(documentDirectory, "settings.json"), JSON.stringify({ summarizeDocuments: true }));
  writeFileSync(join(imageDirectory, "settings.json"), JSON.stringify({ describeImages: false }));
  const sdk = createExtensionSDK("obsidian parser", { namespace: "obsidian", database, messageBus, models, extensionDir: settingsDirectory });
  const documentSDK = createExtensionSDK("process-document", { database, messageBus, models, extensionDir: documentDirectory });
  const imageSDK = createExtensionSDK("process-image", { database, messageBus, models, extensionDir: imageDirectory });
  if (register) { await setupDocument(documentSDK); await setupImage(imageSDK); }
  return {
    directory, database, sdk, documentSDK, imageSDK, settings, files, vaultA, vaultB, events,
    failEmbeddings: (value: boolean) => { embeddingFailure = value; },
    close: () => { sdk.messages.clear(); documentSDK.messages.clear(); imageSDK.messages.clear(); database.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
