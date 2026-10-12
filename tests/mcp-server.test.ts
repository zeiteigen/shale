import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createExtensionSDK } from "../sdk";
import { createTestDatabase } from "./fixtures/database";
import { startMcpServer, type RunningMcpServer } from "../mcp";
import { startWebServer } from "../main/web-server";
import { WebLogs } from "../main/web-logs";
import { formatToolResponse } from "../mcp/types";
import { refreshSourceMemory } from "../mcp/tools/memory";
import { compactTraversal } from "../mcp/tools/search";

const databases: Database[] = [];
const servers: RunningMcpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    try {
      await client.close();
    } catch {}
  }
  for (const server of servers.splice(0)) {
    try {
      await server.close();
    } catch {}
  }
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {}
  }
});

describe("MCP response bounds", () => {
  it("keeps oversized tool results valid JSON within the requested character budget", () => {
    const response = formatToolResponse({items:Array.from({length:1000},(_,i)=>({id:i,text:"x".repeat(200)}))}, 1000);
    const serialized=(response.content[0] as {text:string}).text;
    expect(serialized.length).toBeLessThanOrEqual(1000);
    const parsed=JSON.parse(serialized);
    expect(parsed.truncated).toBe(true);
  });

  it("keeps a continuation cursor aligned when a paged hit array is shortened", () => {
    const response=formatToolResponse({hits:Array.from({length:20},(_,i)=>({id:i,text:"y".repeat(200)})),offset:10,limit:20,totalSources:100,nextOffset:30},1000);
    const parsed=JSON.parse((response.content[0] as {text:string}).text);
    expect(parsed.hits.length).toBe(parsed.limit);
    expect(parsed.nextOffset).toBe(10+parsed.hits.length);
    expect(parsed.truncated).toBe(true);
  });

  it("preserves paged source hits while omitting oversized graph expansion items", () => {
    const response=formatToolResponse({hits:[{sourceId:'a',preview:'a'.repeat(200)},{sourceId:'b',preview:'b'.repeat(200)}],
      offset:5,limit:2,totalSources:20,nextOffset:7,truncated:true,graphTruncated:false,
      relatedPassages:Array.from({length:10},(_,i)=>({revisionId:i,text:'p'.repeat(300)})),
      evidence:Array.from({length:5},(_,i)=>({id:`e${i}`,quote:'q'.repeat(200)})),
      neighborhoods:Array.from({length:5},(_,i)=>({entities:[{name:`n${i}`}],claims:Array.from({length:10},()=>({text:'c'.repeat(100)}))}))},1000);
    const serialized=(response.content[0] as {text:string}).text;
    const parsed=JSON.parse(serialized);
    expect(serialized.length).toBeLessThanOrEqual(1000);
    expect(parsed.hits.length).toBeGreaterThan(0);
    expect(parsed.hits.length).toBe(parsed.limit);
    expect(parsed.nextOffset).toBe(5+parsed.hits.length);
    expect(parsed.graphTruncated).toBe(true);
    expect(Object.keys(parsed.omittedGraphItems)).toEqual(['relatedPassages','evidence','neighborhoods']);
    expect(Object.values(parsed.omittedGraphItems as Record<string,number>).some(count=>count>0)).toBe(true);
  });

  it("groups retained-memory matches by source and returns version citations", async () => {
    const db=createTestDatabase();
    databases.push(db);
    const sdk=createExtensionSDK("memory-search-test",{database:db,namespace:"knowledge"});
    await sdk.ingest.sourceAndChunks({source:{id:"grouped-source",uri:"file:///grouped.md",title:"Grouped",origin:"test",type:"note",hash:"grouped-v1"},chunks:[
      {text_content:"Project Cedar has a distinct archived retrieval token."},
      {text_content:"Project Cedar uses that retrieval token for the second section."},
    ]});
    const result=sdk.memory.search({query:"retrieval token",limit:5});
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.sourceId).toBe("grouped-source");
    expect(result.hits[0]?.memoryVersion).toBe(1);
    expect(result.hits[0]?.snippetVersionId).toBeGreaterThan(0);
    expect(result.hits[0]?.preview.length).toBeLessThanOrEqual(600);
  });

  it("applies filters before ranking and paginates beyond the first five hundred sources", () => {
    const db=createTestDatabase();
    databases.push(db);
    const insertSource=db.query('INSERT INTO sources(id,type,uri,origin,created_at,title,updated_at,hash) VALUES(?,?,?,?,?,?,?,?)');
    const insertChunk=db.query('INSERT INTO chunks(source_id,chunk_index,text_content,chunk_type) VALUES(?,0,?,\'verbatim\')');
    for(let i=0;i<501;i++) {
      const id=`ranked-${i}`;
      insertSource.run(id,'note',`file:///${id}.md`,i===500?'target-origin':'other-origin',i,`Source ${i}`,i,`hash-${i}`);
      insertChunk.run(id,'shared continuation needle');
    }
    insertSource.run('session-result','web_session','https://example.invalid/session','browser',600,'Browsing Session',600,'hash-session');
    insertChunk.run('session-result','shared continuation needle');
    const sdk=createExtensionSDK("bounded-search-test",{database:db,namespace:"knowledge"});
    const filtered=sdk.memory.search({query:"continuation needle",origin:"target-origin",limit:5});
    expect(filtered.totalSources).toBe(1);
    expect(filtered.hits[0]?.sourceId).toBe('ranked-500');
    const page=sdk.memory.search({query:"continuation needle",limit:5,offset:500});
    expect(page.totalSources).toBe(501);
    expect(page.hits).toHaveLength(1);
    expect(page.nextOffset).toBeNull();
    expect(sdk.memory.search({query:"continuation needle",type:"web_session",limit:5}).hits[0]?.sourceId).toBe('session-result');
  });

  it("returns unavailable for an unowned source without attempting a fetch", async () => {
    const db=createTestDatabase();
    databases.push(db);
    const sdk=createExtensionSDK("refresh-test",{database:db,namespace:"knowledge"});
    db.query('INSERT INTO sources(id,type,uri,origin,created_at,title,updated_at,hash) VALUES(?,?,?,?,?,?,?,?)')
      .run('unowned','note','https://example.invalid/page','unconfigured-owner',1,'Unowned',1,'hash');
    expect(sdk.messages.hasHandler('source:refresh')).toBe(false);
    const response=await refreshSourceMemory(sdk,{sourceId:'unowned',actor:'tester',reason:'explicit refresh request'});
    expect(response.status).toBe('unavailable');
    expect(response.sourceId).toBe('unowned');
  });

  it("keeps traversal output compact and reports omitted counts", () => {
    const result=compactTraversal({entities:Array.from({length:40},(_,id)=>({id,stableId:`s${id}`,namespace:'n',name:`Entity ${id}`,type:'Thing',canonicalId:null})),
      claims:Array.from({length:60},(_,id)=>({id:`c${id}`,namespace:'n',subject:id,predicate:'RELATED_TO',object:id+1,value:'z'.repeat(800),status:'accepted' as const,recordedAt:id})),
      paths:[],truncated:true},40,60,1000);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1000);
    expect(result.truncated).toBe(true);
    expect(result.counts.entities).toBe(40);
    expect(result.omitted.claims).toBeGreaterThan(0);
    expect(result.continuationGuidance).toContain('start entity');
  });
});

async function setupServer() {
  const db = createTestDatabase();
  databases.push(db);

  const sdk = createExtensionSDK("mcp-test", {
    database: db,
    namespace: "knowledge",
  });

  const server = await startMcpServer({
    port: 0,
    host: "127.0.0.1",
    sdk,
    namespace: "knowledge",
  });
  servers.push(server);

  return { db, sdk, server, url: server.url };
}

describe("MCP Knowledge Graph HTTP Server", () => {
  it('edits retained memory through the MCP protocol without reconstructing discarded originals',async()=>{
    const {sdk,url}=await setupServer();
    sdk.ingest.sourceAndChunks({source:{id:'memory-protocol',title:'Polar guide',uri:'test://polar',origin:'unconfigured-owner',type:'note'},
      chunks:[{text_content:'Polar coordinates use radius and angle.'}]});
    const client=new Client({name:'memory-protocol-test',version:'1.0.0'});clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    const call=async(name:string,args:Record<string,unknown>)=>client.callTool({name,arguments:args});
    const decode=(response:any)=>JSON.parse(response.content[0].text);
    const before=decode(await call('get_source_memory',{sourceId:'memory-protocol'}));
    expect(before.completeOriginal).toBe(false);
    const version=decode(await call('get_snippet',{versionId:before.snippets[0].versionId}));
    expect(version.text).toBe('Polar coordinates use radius and angle.');
    const edit={sourceId:'memory-protocol',expectedVersion:before.version,actor:'test-agent',reason:'Add an interpretation',requestId:'memory-protocol-edit',
      add:[{text:'Radial symmetry often makes polar coordinates useful.',kind:'derived',purpose:'application'}]};
    const receipt=decode(await call('edit_source_memory',edit));
    expect(receipt.version).toBe(before.version+1);
    expect(decode(await call('edit_source_memory',edit))).toEqual(receipt);
    expect((await call('edit_source_memory',{...edit,requestId:'different-request'})).isError).toBe(true);
    const after=decode(await call('get_source_memory',{sourceId:'memory-protocol'}));
    expect(after.snippets.some((s:any)=>s.kind==='derived'&&s.text.includes('Radial symmetry'))).toBe(true);
    expect(decode(await call('get_snippet',{versionId:before.snippets[0].versionId})).text).toBe(version.text);
    expect(decode(await call('refresh_source',{sourceId:'memory-protocol',actor:'test-agent',reason:'Recover omitted detail',topic:'examples'})).status).toBe('unavailable');
  });

  it("serves HTTP health check, root metadata, and CORS preflights", async () => {
    const { url } = await setupServer();

    // Health check
    const healthRes = await fetch(`${url}/health`);
    expect(healthRes.status).toBe(200);
    const healthJson = await healthRes.json();
    expect(healthJson.status).toBe("ok");
    expect(healthJson.protocol).toBe("mcp");
    expect(healthJson.transports).toEqual(["sse", "streamable-http"]);

    // Root check
    const rootRes = await fetch(`${url}/`);
    expect(rootRes.status).toBe(200);
    const rootJson = await rootRes.json();
    expect(rootJson.server).toBe("shale-knowledge-graph");

    // CORS preflight
    const corsRes = await fetch(`${url}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: url,
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(corsRes.status).toBe(204);
    expect(corsRes.headers.get("access-control-allow-origin")).toBe(url);
    expect(corsRes.headers.get("access-control-allow-methods")).toContain("POST");

    for (const path of ["/mcp", "/sse", "/messages"]) {
      for (const method of ["OPTIONS", "POST", "GET"]) {
        const denied = await fetch(`${url}${path}`, { method, headers: { Origin: "https://untrusted.example" } });
        expect(denied.status).toBe(403);
        expect(denied.headers.get("access-control-allow-origin")).toBeNull();
      }
    }
    expect((await fetch(`${url}/health`, { headers: { Host: "untrusted.example" } })).status).toBe(403);

    // 404 for unknown endpoint
    const notFoundRes = await fetch(`${url}/non-existent`);
    expect(notFoundRes.status).toBe(404);
  });

  it("connects over SSE transport, lists tools, resources, and prompts", async () => {
    const { url } = await setupServer();

    const client = new Client(
      { name: "test-sse-client", version: "1.0.0" },
      { capabilities: {} },
    );
    clients.push(client);

    const transport = new SSEClientTransport(new URL(`${url}/sse`));
    await client.connect(transport);

    // List tools
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);

    expect(toolNames).toContain("search_graph");
    expect(toolNames).toContain("get_source_memory");
    expect(toolNames).toContain("get_snippet");
    expect(toolNames).toContain("edit_source_memory");
    expect(toolNames).toContain("traverse_graph");
    expect(toolNames).toContain("find_path");
    expect(toolNames).toContain("get_entity");
    expect(toolNames).toContain("resolve_entities");
    expect(toolNames).toContain("create_entity");
    expect(toolNames).toContain("rename_entity");
    expect(toolNames).toContain("merge_entities");
    expect(toolNames).toContain("unmerge_entities");
    expect(toolNames).toContain("inspect_entity");
    expect(toolNames).toContain("add_entity_alias");
    expect(toolNames).toContain("get_claim");
    expect(toolNames).toContain("list_claims");
    expect(toolNames).toContain("add_claim");
    expect(toolNames).toContain("batch_add_claims");
    expect(toolNames).toContain("inspect_claim");
    expect(toolNames).toContain("review_claim");
    expect(toolNames).toContain("link_claims");
    expect(toolNames).toContain("find_conflicts");
    expect(toolNames).toContain("list_relations");
    expect(toolNames).toContain("define_relation");
    expect(toolNames).toContain("infer_transitive");
    expect(toolNames).toContain("create_event");
    expect(toolNames).toContain("get_event");
    expect(toolNames).toContain("list_events");
    expect(toolNames).toContain("add_evidence");
    expect(toolNames).toContain("get_claim_evidence");
    expect(toolNames).toContain("get_graph_stats");

    // List resources
    const resources = await client.listResources();
    const resourceUris = resources.resources.map((r) => r.uri);
    expect(resourceUris).toContain("graph://stats");
    expect(resourceUris).toContain("graph://relations");

    // Read resource
    const statsResource = await client.readResource({ uri: "graph://stats" });
    expect(statsResource.contents).toHaveLength(1);
    const content = statsResource.contents[0] as { text: string };
    const parsedStats = JSON.parse(content.text);
    expect(parsedStats).toHaveProperty("entitiesCount");
    expect(parsedStats).toHaveProperty("claimsCount");

    // List prompts
    const prompts = await client.listPrompts();
    const promptNames = prompts.prompts.map((p) => p.name);
    expect(promptNames).toContain("explore-entity");
    expect(promptNames).toContain("verify-claim");
    expect(promptNames).toContain("fact-check");

    // Get prompt
    const promptRes = await client.getPrompt({
      name: "explore-entity",
      arguments: { entityName: "Alice" },
    });
    expect(promptRes.messages).toHaveLength(1);
    const messageContent = promptRes.messages[0].content as { text: string };
    expect(messageContent.text).toContain("Alice");
    const factCheckPrompt=await client.getPrompt({name:"fact-check",arguments:{statement:"A test statement"}});
    const factCheckText=(factCheckPrompt.messages[0].content as {text:string}).text;
    expect(factCheckText).toContain("summaryVersionId");
    expect(factCheckText).toContain("refresh_source");
  });

  it("performs full knowledge graph entity, claim, event, and traversal workflows via MCP tools", async () => {
    const { sdk, url } = await setupServer();

    // Ingest a source so exact evidence citations can be anchored
    await sdk.ingest.sourceAndChunks({
      source: {
        id: "source-1",
        uri: "file:///atlas.md",
        title: "Atlas Documentation",
        origin: "test",
        type: "note",
        hash: "v1",
      },
      chunks: [
        {
          text_content: "Alice leads the Atlas project as principal engineer.",
        },
      ],
    });

    const client = new Client(
      { name: "test-agent", version: "1.0.0" },
      { capabilities: {} },
    );
    clients.push(client);

    await client.connect(new SSEClientTransport(new URL(`${url}/sse`)));

    // 1. Create entities
    const createAliceRes = await client.callTool({
      name: "create_entity",
      arguments: {
        name: "Alice",
        type: "Person",
        aliases: ["Ali", { name: "A.", scope: "team:atlas" }],
      },
    });
    const alice = JSON.parse((createAliceRes.content as any)[0].text);
    expect(alice.name).toBe("Alice");
    expect(alice.id).toBeGreaterThan(0);

    const createAtlasRes = await client.callTool({
      name: "create_entity",
      arguments: {
        name: "Atlas",
        type: "Project",
      },
    });
    const atlas = JSON.parse((createAtlasRes.content as any)[0].text);
    expect(atlas.name).toBe("Atlas");

    // 2. Resolve entities
    const resolveRes = await client.callTool({
      name: "resolve_entities",
      arguments: { name: "Alice" },
    });
    const resolved = JSON.parse((resolveRes.content as any)[0].text);
    expect(resolved.count).toBe(1);
    expect(resolved.entities[0].id).toBe(alice.id);

    // 3. Inspect entity
    const inspectEntityRes = await client.callTool({
      name: "inspect_entity",
      arguments: { id: alice.id },
    });
    const inspectedAlice = JSON.parse((inspectEntityRes.content as any)[0].text);
    expect(inspectedAlice.entity.name).toBe("Alice");
    expect(inspectedAlice.aliases).toHaveLength(3); // primary name + 2 extra aliases

    // 4. Add claim using resolved names
    const addClaimRes = await client.callTool({
      name: "add_claim",
      arguments: {
        subject: "Alice",
        predicate: "LEADS",
        object: "Atlas",
        confidence: 0.95,
        status: "accepted",
        context: "team:atlas",
      },
    });
    const claim = JSON.parse((addClaimRes.content as any)[0].text);
    expect(claim.subject).toBe(alice.id);
    expect(claim.object).toBe(atlas.id);
    expect(claim.predicate).toBe("LEADS");
    expect(claim.confidence).toBe(0.95);
    expect(claim.status).toBe("accepted");

    // 5. Query claims
    const listClaimsRes = await client.callTool({
      name: "list_claims",
      arguments: { entityId: alice.id },
    });
    const claimsList = JSON.parse((listClaimsRes.content as any)[0].text);
    expect(claimsList.count).toBe(1);
    expect(claimsList.claims[0].id).toBe(claim.id);

    // 6. Inspect claim
    const inspectClaimRes = await client.callTool({
      name: "inspect_claim",
      arguments: { id: claim.id },
    });
    const claimInspection = JSON.parse((inspectClaimRes.content as any)[0].text);
    expect(claimInspection.claim.id).toBe(claim.id);

    // 7. Add evidence to claim anchored to source
    const addEvidenceRes = await client.callTool({
      name: "add_evidence",
      arguments: {
        claimId: claim.id,
        sourceId: "source-1",
        chunkIndex: 0,
        quote: "Alice leads the Atlas project as principal engineer.",
        stance: "supports",
        confidence: 0.98,
      },
    });
    const evidenceAdded = JSON.parse((addEvidenceRes.content as any)[0].text);
    expect(evidenceAdded.success).toBe(true);

    const getEvidenceRes = await client.callTool({
      name: "get_claim_evidence",
      arguments: { claimId: claim.id },
    });
    const evidenceList = JSON.parse((getEvidenceRes.content as any)[0].text);
    expect(evidenceList.count).toBe(1);
    expect(evidenceList.evidence[0].quote).toContain("Alice leads");

    // 8. Review claim
    const reviewRes = await client.callTool({
      name: "review_claim",
      arguments: {
        claimId: claim.id,
        status: "disputed",
        actor: "agent-evaluator",
        reason: "Organizational leadership change in Q3",
      },
    });
    const reviewedClaim = JSON.parse((reviewRes.content as any)[0].text);
    expect(reviewedClaim.status).toBe("disputed");

    // 9. Traverse graph
    const traverseRes = await client.callTool({
      name: "traverse_graph",
      arguments: {
        start: alice.id,
        statuses: ["accepted", "disputed"],
      },
    });
    const traversal = JSON.parse((traverseRes.content as any)[0].text);
    expect(traversal.entities.map((e: any) => e.id)).toContain(atlas.id);
    expect(traversal.claims).toHaveLength(1);

    // 10. Find path
    const pathRes = await client.callTool({
      name: "find_path",
      arguments: {
        start: "Alice",
        target: "Atlas",
        statuses: ["accepted", "disputed"],
      },
    });
    const pathData = JSON.parse((pathRes.content as any)[0].text);
    expect(pathData.path.depth).toBe(1);
    expect(pathData.path.entityIds).toEqual([alice.id, atlas.id]);
    expect(pathData.path.claimIds).toHaveLength(1);

    // 11. Search graph
    const searchRes = await client.callTool({
      name: "search_graph",
      arguments: {
        query: "Alice Atlas",
        mode: "bm25",
      },
    });
    const searchData = JSON.parse((searchRes.content as any)[0].text);
    expect(searchData.hits.length).toBeGreaterThan(0);
    expect(searchData.hits[0].sourceId).toBe("source-1");
    expect(searchData.hits[0].preview).toContain("Alice leads the Atlas project");
    expect(searchData.hits[0].memoryVersion).toBe(1);
    expect(searchData.hits[0].snippetVersionId).toBeGreaterThan(0);

    const memoryRes = await client.callTool({name:"get_source_memory",arguments:{sourceId:"source-1"}});
    const memory = JSON.parse((memoryRes.content as any)[0].text);
    expect(memory.completeOriginal).toBe(false);
    expect(memory.snippets).toHaveLength(1);
    const snippetRes = await client.callTool({name:"get_snippet",arguments:{versionId:memory.snippets[0].versionId}});
    expect(JSON.parse((snippetRes.content as any)[0].text).completeOriginal).toBe(false);
    const memoryResource=await client.readResource({uri:"graph://sources/source-1/memory/0"});
    const memoryResourceData=JSON.parse((memoryResource.contents[0] as {text:string}).text);
    expect(memoryResourceData.completeOriginal).toBe(false);
    expect(memoryResourceData.snippets[0].versionId).toBe(memory.snippets[0].versionId);

    // 12. Create & query events
    const createEventRes = await client.callTool({
      name: "create_event",
      arguments: {
        name: "Atlas Architecture Review",
        kind: "Meeting",
        context: "team:atlas",
        participants: [
          { entity: "Alice", role: "presenter" },
          { entity: "Atlas", role: "topic" },
        ],
        status: "accepted",
      },
    });
    const event = JSON.parse((createEventRes.content as any)[0].text);
    expect(event.entity.name).toBe("Atlas Architecture Review");
    expect(event.participants).toHaveLength(2);

    const listEventsRes = await client.callTool({
      name: "list_events",
      arguments: { kind: "Meeting" },
    });
    const eventsList = JSON.parse((listEventsRes.content as any)[0].text);
    expect(eventsList.count).toBe(1);

    // 13. Relations
    const defineRelRes = await client.callTool({
      name: "define_relation",
      arguments: {
        name: "DEPENDS_ON",
        sourceTypes: ["Project"],
        targetTypes: ["Project"],
        transitive: true,
      },
    });
    expect(JSON.parse((defineRelRes.content as any)[0].text).success).toBe(true);

    const listRelsRes = await client.callTool({
      name: "list_relations",
      arguments: {},
    });
    const relsList = JSON.parse((listRelsRes.content as any)[0].text);
    expect(relsList.relations.map((r: any) => r.name)).toContain("DEPENDS_ON");

    // 14. Reversible identity merge
    const createBobRes = await client.callTool({
      name: "create_entity",
      arguments: { name: "Alice M.", type: "Person" },
    });
    const bob = JSON.parse((createBobRes.content as any)[0].text);

    const mergeRes = await client.callTool({
      name: "merge_entities",
      arguments: { from: bob.id, into: alice.id, reason: "Same person identified by user" },
    });
    const mergeData = JSON.parse((mergeRes.content as any)[0].text);
    expect(mergeData.success).toBe(true);

    const unmergeRes = await client.callTool({
      name: "unmerge_entities",
      arguments: { changeId: mergeData.changeId },
    });
    expect(JSON.parse((unmergeRes.content as any)[0].text).success).toBe(true);

    // 15. Graph stats
    const statsRes = await client.callTool({
      name: "get_graph_stats",
      arguments: {},
    });
    const stats = JSON.parse((statsRes.content as any)[0].text);
    expect(stats.entitiesCount).toBeGreaterThanOrEqual(2);
    expect(stats.claimsCount).toBeGreaterThanOrEqual(1);
  });

  it("handles batch ingestion, conflicts, transitive reasoning, and linking", async () => {
    const { url } = await setupServer();

    const client = new Client(
      { name: "test-advanced-agent", version: "1.0.0" },
      { capabilities: {} },
    );
    clients.push(client);
    await client.connect(new SSEClientTransport(new URL(`${url}/sse`)));

    // Create 3 entities for transitive chain: Core -> Subsystem -> Component
    const resA = await client.callTool({
      name: "create_entity",
      arguments: { name: "Core", type: "Module" },
    });
    const core = JSON.parse((resA.content as any)[0].text);

    const resB = await client.callTool({
      name: "create_entity",
      arguments: { name: "Subsystem", type: "Module" },
    });
    const subsystem = JSON.parse((resB.content as any)[0].text);

    const resC = await client.callTool({
      name: "create_entity",
      arguments: { name: "Component", type: "Module" },
    });
    const component = JSON.parse((resC.content as any)[0].text);

    // Define transitive PART_OF relation
    await client.callTool({
      name: "define_relation",
      arguments: { name: "PART_OF", transitive: true },
    });

    // Batch add claims
    const batchRes = await client.callTool({
      name: "batch_add_claims",
      arguments: {
        claims: [
          { subject: component.id, predicate: "PART_OF", object: subsystem.id, status: "accepted" },
          { subject: subsystem.id, predicate: "PART_OF", object: core.id, status: "accepted" },
        ],
      },
    });
    const batchData = JSON.parse((batchRes.content as any)[0].text);
    expect(batchData.count).toBe(2);

    // Transitive inference
    const inferRes = await client.callTool({
      name: "infer_transitive",
      arguments: { predicate: "PART_OF" },
    });
    const inferData = JSON.parse((inferRes.content as any)[0].text);
    expect(inferData.claimIds.length).toBeGreaterThan(0);

    // Add conflicting claim with negative polarity
    await client.callTool({
      name: "add_claim",
      arguments: {
        subject: component.id,
        predicate: "PART_OF",
        object: subsystem.id,
        polarity: -1,
        status: "accepted",
      },
    });

    // Find conflicts
    const conflictRes = await client.callTool({
      name: "find_conflicts",
      arguments: { entityId: component.id },
    });
    const conflictData = JSON.parse((conflictRes.content as any)[0].text);
    expect(conflictData.conflicts.length).toBeGreaterThanOrEqual(1);

    // Link claims (mark one as contradicting another)
    const allClaimsRes = await client.callTool({
      name: "list_claims",
      arguments: { subject: component.id },
    });
    const allClaims = JSON.parse((allClaimsRes.content as any)[0].text);
    const posClaim = allClaims.claims.find((c: any) => c.polarity === 1);
    const negClaim = allClaims.claims.find((c: any) => c.polarity === -1);
    expect(posClaim).toBeDefined();
    expect(negClaim).toBeDefined();

    const linkRes = await client.callTool({
      name: "link_claims",
      arguments: {
        from: negClaim.id,
        to: posClaim.id,
        relation: "contradicts",
        reason: "Conflicting architectural documentation",
      },
    });
    expect(JSON.parse((linkRes.content as any)[0].text).success).toBe(true);

    // Rename entity
    const renameRes = await client.callTool({
      name: "rename_entity",
      arguments: { id: core.id, name: "Core Engine" },
    });
    expect(JSON.parse((renameRes.content as any)[0].text).name).toBe("Core Engine");

    // Add entity alias
    const aliasRes = await client.callTool({
      name: "add_entity_alias",
      arguments: { id: core.id, alias: "Kernel" },
    });
    expect(JSON.parse((aliasRes.content as any)[0].text).success).toBe(true);
  });

  it("connects over Streamable HTTP transport and interacts with knowledge graph", async () => {
    const { url } = await setupServer();

    const client = new Client(
      { name: "test-streamable-client", version: "1.0.0" },
      { capabilities: {} },
    );
    clients.push(client);

    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
    await client.connect(transport);

    // Tool call over Streamable HTTP
    const createRes = await client.callTool({
      name: "create_entity",
      arguments: {
        name: "Carol",
        type: "Person",
      },
    });
    const carol = JSON.parse((createRes.content as any)[0].text);
    expect(carol.name).toBe("Carol");

    // Get entity
    const getRes = await client.callTool({
      name: "get_entity",
      arguments: { id: carol.id },
    });
    const fetched = JSON.parse((getRes.content as any)[0].text);
    expect(fetched.id).toBe(carol.id);
    expect(fetched.name).toBe("Carol");

    // Check stats
    const statsRes = await client.callTool({
      name: "get_graph_stats",
      arguments: {},
    });
    const stats = JSON.parse((statsRes.content as any)[0].text);
    expect(stats.entitiesCount).toBe(1);
  });

  it("proxies MCP requests transparently through startWebServer (main web server)", async () => {
    const { url: mcpBackendUrl } = await setupServer();
    const logs = new WebLogs();
    const webContext = {
      rootDir: "/tmp",
      crons: [],
      extensions: new Map(),
      runCron: async () => {},
      runAllCrons: async () => {},
      logs,
      shutdown: () => {},
      port: () => webServer.port!,
      command: async () => ({ success: true, output: "" }),
    };

    const webServer = startWebServer(
      webContext as any,
      {
        health: () => Response.json({ status: "ok", mcp: mcpBackendUrl }),
        connectors: () => Response.json({}),
        connector: () => Response.json({}),
        ingest: () => Response.json({}),
        mcpUrl: () => mcpBackendUrl,
      },
      0,
    );

    try {
      const proxyBase = `http://127.0.0.1:${webServer.port}`;

      for (const path of ["/mcp", "/sse", "/messages", "/mcp/health"]) {
        for (const method of ["OPTIONS", "POST", "GET"]) {
          const denied = await fetch(`${proxyBase}${path}`, { method, headers: { Origin: "https://untrusted.example", "Sec-Fetch-Site": "cross-site" } });
          expect(denied.status).toBe(403);
        }
      }

      // Health check proxied
      const healthRes = await fetch(`${proxyBase}/mcp/health`);
      expect(healthRes.status).toBe(200);
      const healthJson = await healthRes.json();
      expect(healthJson.protocol).toBe("mcp");

      // Main health endpoint reports MCP URL
      const mainHealthRes = await fetch(`${proxyBase}/health`);
      const mainHealthJson = await mainHealthRes.json();
      expect(mainHealthJson.mcp).toBe(mcpBackendUrl);

      // Connect Streamable HTTP client directly through the webServer port!
      const streamClient = new Client(
        { name: "web-gateway-streamable", version: "1.0.0" },
        { capabilities: {} },
      );
      clients.push(streamClient);
      await streamClient.connect(new StreamableHTTPClientTransport(new URL(`${proxyBase}/mcp`),
        { requestInit: { headers: { Origin: proxyBase, "Sec-Fetch-Site": "same-origin" } } }));

      const statsRes = await streamClient.callTool({
        name: "get_graph_stats",
        arguments: {},
      });
      const stats = JSON.parse((statsRes.content as any)[0].text);
      expect(stats).toHaveProperty("entitiesCount");

      // Connect SSE client directly through the webServer port!
      const sseClient = new Client(
        { name: "web-gateway-sse", version: "1.0.0" },
        { capabilities: {} },
      );
      clients.push(sseClient);
      await sseClient.connect(new SSEClientTransport(new URL(`${proxyBase}/sse`)));

      const toolsList = await sseClient.listTools();
      expect(toolsList.tools.length).toBeGreaterThan(0);
    } finally {
      webServer.stop(true);
    }
  });
});
