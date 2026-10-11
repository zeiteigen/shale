import { expect, it } from "bun:test";
import { createExtensionSDK, SourceGraph } from "../sdk";
import { createTestDatabase } from "./fixtures/database";
import { getGraphData } from "../visualizer/graph-data";
import { startVisualizerServer } from "../visualizer/server";

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
      expect(node.sourceId).toBe(`note-${index}`);
      expect(node.sourceUri).toBe(`file:///vault-${index}/Same.md`);
      expect(node.chunksCount).toBe(8);
      expect(node.chunks).toHaveLength(5);
      expect(node.chunks[0].text_content).toContain(`vault ${index}`);
      expect(node.chunks.slice(1).every(chunk => chunk.text_content.startsWith(`vault ${index} `))).toBe(true);
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
    expect(results).toHaveLength(4);
    expect(new Set(results.map(result => result.source_id))).toEqual(new Set(['search-0', 'search-1']));
    for(const result of results)expect(result.entity_id).toBe(ids[Number(result.source_id.slice(-1))]);
  } finally {database.close();}
});

it('loads complete retained memory on demand through the guarded viewer API', async () => {
  const database = createTestDatabase(), sdk = createExtensionSDK('obsidian', { database });
  const sourceId = 'viewer-memory';
  sdk.ingest.sourceAndChunks({ source: { id: sourceId, type: 'note', origin: 'obsidian', uri: 'file:///notes/memory.md', title: 'Retained memory' },
    chunks: Array.from({ length: 10 }, (_, index) => ({ text_content: `Distinct section ${index} explains a source concept.` })) });
  const graph = new SourceGraph(database, sdk.graph, sourceId, 'obsidian');
  const entity = graph.entity('file:///notes/memory.md', 'Retained memory', 'Note');
  graph.claim(entity, 'SOURCE_URI', { value: 'file:///notes/memory.md' });
  const server = startVisualizerServer(0, sdk), base = `http://127.0.0.1:${server.port}`;
  try {
    const preview = getGraphData(sdk).nodes.find(node => node.id === entity)!;
    expect(preview.sourceId).toBe(sourceId);
    expect(preview.chunks).toHaveLength(5);
    const response = await fetch(`${base}/api/knowledge/memory?sourceId=${sourceId}`);
    expect(response.status).toBe(200);
    const memory = await response.json();
    expect(memory.source.id).toBe(sourceId);
    expect(memory.snippets).toHaveLength(10);
    expect(memory.snippets.at(-1).text).toContain('Distinct section 9');
    expect(memory.completeOriginal).toBe(false);
    expect((await fetch(`${base}/api/knowledge/memory`)).status).toBe(400);
    expect((await fetch(`${base}/api/knowledge/memory?sourceId=missing`)).status).toBe(400);
    expect((await fetch(`${base}/api/knowledge/memory?sourceId=${sourceId}`, { headers: { Origin: 'https://external.example' } })).status).toBe(403);
  } finally { server.stop(true); database.close(); }
});
