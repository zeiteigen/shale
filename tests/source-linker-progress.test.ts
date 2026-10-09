import { expect, it } from "bun:test";
import { createExtensionSDK } from "../sdk";
import { createTestDatabase } from "./fixtures/database";
import { processSourceLinks, commitLinksToGraph } from "../extensions/source-linker/process-links";
import { run as recover } from "../extensions/source-linker/recover";
import { analyzeSourcePairWithLLM } from "../extensions/source-linker/llm-analyzer";
import { BATCH_ID, WATERMARK_KEY, pairCheckpointId, readLinkBatch } from "../extensions/source-linker/link-batch";
import type { SourceCandidatePair } from "../extensions/source-linker/types";
import { getGraphData } from "../visualizer/graph-data";
import { runCheckpointRecover } from "../main/index";
import { join } from "node:path";

function fixture() {
  const database = createTestDatabase();
  const sdk = createExtensionSDK("source-linker", { database });
  for (const [i, title] of ["Same title", "Same title", "Third"].entries()) {
    sdk.ingest.sourceAndChunks({
      source: { id: `id${i}`, type: "test", origin: "test", uri: `uri:${i}`, title, updated_at: 100 + i },
      chunks: [{ text_content: `content ${i}` }],
    });
  }
  const sources = sdk.context.getAllSources();
  const pair: SourceCandidatePair = { sourceA: sources[0], sourceB: sources[1], textScore: 1, matchedChunkIds: [] };
  const analysis = { shouldLink: true, relation: "RELATES_TO", reason: "Similar", weight: 0.9, entityResolutions: [] };
  sdk.queryLLM = (async () => JSON.stringify(analysis)) as any;
  return { database, sdk, pair, analysis };
}

it("retains failed analyses and candidate overflow across bounded runs", async () => {
  const { database, sdk, analysis } = fixture();
  let calls = 0;
  sdk.queryLLM = (async () => { calls++; throw new Error("Offline"); }) as any;
  try {
    await expect(processSourceLinks(sdk, { maxPairsPerRun: 1 })).rejects.toThrow("Offline");
    expect(sdk.state.getWatermark(WATERMARK_KEY)).toBeNull();
    expect(readLinkBatch(sdk)?.pairs).toHaveLength(3);
    sdk.queryLLM = (async () => { calls++; return JSON.stringify(analysis); }) as any;
    await processSourceLinks(sdk, { maxPairsPerRun: 1 });
    expect(readLinkBatch(sdk)?.pairs).toHaveLength(2);
    expect(sdk.state.getWatermark(WATERMARK_KEY)).toBeNull();
    await processSourceLinks(sdk, { maxPairsPerRun: 1 });
    await processSourceLinks(sdk, { maxPairsPerRun: 1 });
    expect(sdk.hasCheckpoints()).toBe(false);
    expect(sdk.state.getWatermark(WATERMARK_KEY)).toBe("102");
    expect(calls).toBe(4);
    expect((await processSourceLinks(sdk)).sourcesAnalyzed).toBe(0);
  } finally { database.close(); }
});

it("recovers evaluated pairs without skipping unfinished batch members", async () => {
  const { database, sdk, pair } = fixture();
  const other: SourceCandidatePair = { ...pair, sourceB: sdk.context.getSource("id2")! };
  try {
    sdk.saveCheckpoint({ type: "link_batch", sourcesAnalyzed: 3, maxUpdatedAt: 102, pairs: [pair, other] }, { id: BATCH_ID });
    await analyzeSourcePairWithLLM(pair, sdk);
    await runCheckpointRecover("source-linker", join(import.meta.dir, "../extensions/source-linker/recover.ts"), undefined, sdk);
    expect(sdk.state.getWatermark(WATERMARK_KEY)).toBeNull();
    expect(readLinkBatch(sdk)?.pairs).toHaveLength(1);
    await processSourceLinks(sdk);
    expect(sdk.state.getWatermark(WATERMARK_KEY)).toBe("102");
    expect(sdk.hasCheckpoints()).toBe(false);
  } finally { database.close(); }
});

it("commits graph edges and batch progress in the same transaction", async () => {
  const { database, sdk } = fixture();
  const original = sdk.graph.ingest.bind(sdk.graph);
  sdk.graph.ingest = ((options) => { original(options); throw new Error("Commit failed"); }) as typeof sdk.graph.ingest;
  try {
    await expect(processSourceLinks(sdk)).rejects.toThrow("Commit failed");
    expect(database.query("SELECT * FROM edges").all()).toHaveLength(0);
    expect(readLinkBatch(sdk)?.pairs).toHaveLength(3);
    expect(sdk.state.getWatermark(WATERMARK_KEY)).toBeNull();
    sdk.graph.ingest = original;
    await recover(sdk);
    expect(database.query("SELECT * FROM edges").all()).toHaveLength(6);
    expect(sdk.state.getWatermark(WATERMARK_KEY)).toBe("102");
  } finally { database.close(); }
});

it("applies the same confidence decision to fresh, cached, and legacy recovered analyses", async () => {
  const { database, sdk, pair, analysis } = fixture();
  sdk.queryLLM = (async () => JSON.stringify({ ...analysis, weight: 0.1 })) as any;
  try {
    expect(await analyzeSourcePairWithLLM(pair, sdk)).toBeNull();
    expect(await analyzeSourcePairWithLLM(pair, sdk)).toBeNull();
    await recover(sdk);
    expect(database.query("SELECT * FROM edges").all()).toHaveLength(0);
    sdk.saveCheckpoint({ sourceA: pair.sourceA, sourceB: pair.sourceB, analysis: { ...analysis, weight: 0.1 }, textScore: 1 }, { id: pairCheckpointId(pair) });
    await recover(sdk);
    expect(database.query("SELECT * FROM edges").all()).toHaveLength(0);
    expect(sdk.state.getWatermark(WATERMARK_KEY)).toBeNull();
  } finally { database.close(); }
});

it("keeps same-titled sources distinct and maps visualizer chunks by source ID", () => {
  const { database, sdk, pair, analysis } = fixture();
  try {
    expect(commitLinksToGraph([{
      sourceIdA: pair.sourceA.id, sourceTitleA: pair.sourceA.title,
      sourceIdB: pair.sourceB.id, sourceTitleB: pair.sourceB.title,
      ...analysis, textScore: 1,
    }], sdk)).toBe(2);
    const graph = getGraphData(sdk);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.map((node) => node.sourceUri).sort()).toEqual(["uri:0", "uri:1"]);
    expect(graph.nodes.map((node) => node.chunks[0].text_content).sort()).toEqual(["content 0", "content 1"]);
    expect(graph.nodes.map((node) => node.name)).toEqual(["Same title", "Same title"]);
  } finally { database.close(); }
});
