import { expect, it } from "bun:test";
import { createExtensionSDK } from "../sdk";
import { createTestDatabase } from "./fixtures/database";
import { findCandidatePairs } from "../extensions/source-linker/candidate-finder";

it("finds cross-source text candidates before limiting and deduplicates reciprocal matches", async () => {
  const db = createTestDatabase();
  try {
    const sdk = createExtensionSDK("candidate-test", { database: db });
    const ingest = (id: string, texts: string[]) => sdk.ingest.sourceAndChunks({
      source: { id, uri: `test://${id}`, title: id, type: "text", origin: "test" },
      chunks: texts.map(text_content => ({ text_content })),
    });
    ingest("a", Array(70).fill("quantum entanglement physics"));
    ingest("b", ["quantum entanglement physics"]);
    ingest("c", ["gardening tomatoes compost"]);
    const pairs = await findCandidatePairs(sdk.context.getAllSources(), sdk, { candidatesPerChunk: 1, maxPairsPerRun: 10 });
    expect(pairs).toHaveLength(1);
    expect([pairs[0].sourceA.id, pairs[0].sourceB.id]).toEqual(["a", "b"]);
    expect(pairs[0].textScore).toBeGreaterThan(0);
    expect(new Set(pairs[0].matchedChunkIds).size).toBe(pairs[0].matchedChunkIds.length);
    await expect(findCandidatePairs([], sdk, { candidatesPerChunk: 0 })).rejects.toThrow("positive integers");
  } finally { db.close(); }
});
