import { expect, it } from "bun:test";
import { createExtensionSDK, SourceGraph } from "../sdk";
import { createTestDatabase } from "./fixtures/database";
import { getGraphData } from "../visualizer/graph-data";

it("maps connector nodes to their own evidence despite duplicate and renamed titles", () => {
  const database = createTestDatabase();
  const sdk = createExtensionSDK("obsidian", { database });
  try {
    const ids: number[] = [];
    for (const index of [0, 1]) {
      const sourceId = `note-${index}`, uri = `file:///vault-${index}/Same.md`;
      sdk.ingest.sourceAndChunks({
        source: { id: sourceId, type: "note", origin: "obsidian", uri, title: "Same", updated_at: 100 },
        chunks: Array.from({ length: 7 }, (_, chunk_index) => ({ chunk_index,
          text_content: `vault ${index} passage ${chunk_index}` })),
      });
      const graph = new SourceGraph(database, sdk.graph, sourceId, "obsidian");
      const node = graph.entity(uri, "Same", "Note");
      graph.claim(node, "SOURCE_URI", { value: uri });
      ids.push(node);
    }
    sdk.graph.entities.rename(ids[1], "Renamed display label");
    const tag = sdk.graph.entities.create({ name: "Same", type: "Tag" });
    const graph = getGraphData(sdk);
    expect(graph.nodes.find(node => node.id === tag.id)?.chunksCount).toBe(0);
    for (const [index, id] of ids.entries()) {
      const node = graph.nodes.find(node => node.id === id)!;
      expect(node.sourceUri).toBe(`file:///vault-${index}/Same.md`);
      expect(node.chunksCount).toBe(7);
      expect(node.chunks).toHaveLength(5);
      expect(node.chunks.every(chunk => chunk.text_content.startsWith(`vault ${index} `))).toBe(true);
    }
  } finally { database.close(); }
});

it("links search results to connector identities after renames and with duplicate titles", async () => {
  const database=createTestDatabase(),sdk=createExtensionSDK('obsidian',{database});
  try {
    const {enrichResults}=await import('../visualizer/search-results');
    const ids:number[]=[];
    for(const index of [0,1]){
      const sourceId=`search-${index}`,uri=`file:///vault-${index}/Same.md`;
      sdk.ingest.sourceAndChunks({source:{id:sourceId,type:'note',origin:'obsidian',uri,title:'Same'},
        chunks:[{text_content:`Shared term in vault ${index}`} ]});
      const graph=new SourceGraph(database,sdk.graph,sourceId,'obsidian');
      const node=graph.entity(uri,'Same','Note');graph.claim(node,'SOURCE_URI',{value:uri});ids.push(node);
    }
    sdk.graph.entities.rename(ids[1],'New label');
    sdk.graph.entities.create({name:'Same',type:'Tag'});
    const results=enrichResults(await sdk.search.bm25({query:'Shared term',limit:10}),database);
    expect(results).toHaveLength(2);
    for(const result of results)expect(result.entity_id).toBe(ids[Number(result.source_id.slice(-1))]);
  } finally {database.close();}
});
