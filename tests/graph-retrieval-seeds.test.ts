import { expect, it } from "bun:test";
import { createExtensionSDK } from "../sdk";
import { createTestDatabase } from "./fixtures/database";
import { sourceEntityName } from "../lib/source-identity";
import { retrievalSeeds } from "../sdk/graph/retrieval-seeds";

it("prioritizes each retrieved source over crowded incidental chunk entities", () => {
  const db = createTestDatabase();
  const sdk = createExtensionSDK("test", { database: db });
  try {
    for (const id of ["a", "b"]) sdk.ingest.sourceAndChunks({
      source: { id, uri: `test:${id}`, title: id, type: "test", origin: "test" },
      chunks: [{ text_content: id }],
    });
    const mentions = sdk.graph.ingest({ edges: [], entities: Array.from({length:25}, (_,i) => ({name:`mention${i}`,type:"Concept"})) });
    const chunk = db.query<{id:number}, []>("SELECT id FROM chunks WHERE source_id='a'").get()!;
    for (const id of Object.values(mentions.entityMap)) db.run("INSERT OR IGNORE INTO chunk_entities VALUES(?,?)", [chunk.id,id]);
    const owners = sdk.graph.ingest({ edges: [], entities: ["a","b"].map(id => ({name:sourceEntityName(id),type:"Source"})) });
    const results = db.query("SELECT id,source_id,text_content FROM chunks ORDER BY source_id").all() as any;
    const seeds = [...retrievalSeeds(db, sdk.graph, results)];
    expect(seeds.slice(0,2)).toEqual([owners.entityMap[sourceEntityName("a")],owners.entityMap[sourceEntityName("b")]]);
    expect(seeds.length).toBeGreaterThan(2);
  } finally { db.close(); }
});
