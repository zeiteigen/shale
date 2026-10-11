import { expect, it } from "bun:test";
import { documentKnowledge } from "../extensions/process-document/document-knowledge";
import { commitDocument } from "../extensions/obsidian/commit-document";
import { createExtensionSDK } from "../sdk";
import { createTestDatabase } from "./fixtures/database";

it("retains page locations and proposed model provenance for vision text alongside native document text", () => {
  const database = createTestDatabase();
  const sdk = createExtensionSDK("obsidian parser", { database, namespace: "obsidian" });
  const chunks = [
    { chunk_index: 0, chunk_type: "synthetic" as const, text_content: "A radial unit vector points outward.",
      metadata: { origin: "vision-transcription", pageNumber: 2, model: "vision-test" } },
    { chunk_index: 1, chunk_type: "verbatim" as const, text_content: "Reliable native text.", metadata: { pageNumber: 3 } },
  ];
  try {
    const knowledge = documentKnowledge(chunks);
    expect(knowledge).toHaveLength(1);
    expect(knowledge[0]).toMatchObject({ method: "vision", model: "vision-test", status: "proposed", chunkIndex: 0,
      value: { pageNumber: 2, text: chunks[0].text_content } });
    commitDocument(sdk, { filePath: "/vault/lecture.pdf", documentTitle: "Lecture", documentUri: "file:///vault/lecture.pdf",
      updatedAt: 100, metadata: {}, knowledge, contextualChunks: chunks }, { name: "Vault", path: "/vault" });
    const claim = sdk.graph.claims.list({ predicate: "VISION_TRANSCRIPTION" })[0];
    expect(claim).toMatchObject({ status: "proposed", model: "vision-test", method: "vision" });
    expect(sdk.graph.evidence.list(claim.id).some(e => e.chunkIndex === 1)).toBe(true);
    const locators=database.query<{locator:string}, []>("SELECT locator FROM graph_revision_passages WHERE locator != '{}' ").all().map(row=>JSON.parse(row.locator));
    expect(locators.map((locator:any)=>locator.pageNumber)).toEqual(expect.arrayContaining([2,3]));
  } finally { database.close(); }
});

it("rejects generated transcription chunks whose model or original page was lost", () => {
  expect(() => documentKnowledge([{ chunk_index: 0, text_content: "Text", metadata: { origin: "vision-transcription", pageNumber: 1 } }]))
    .toThrow("requires its model");
});
