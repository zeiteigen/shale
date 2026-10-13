import { afterEach, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { run } from '../extensions/knowledge-extractor';
import { run as recover } from '../extensions/knowledge-extractor/recover';
import { parseExtraction } from '../extensions/knowledge-extractor/parse';
import { consistentDatatype } from '../extensions/knowledge-extractor/commit';
import { acquireTaskLease } from '../lib/task-lease';
import { extractionCursorKey } from '../extensions/knowledge-extractor/source-window';
import { TruncatedChatCompletionError } from '../lib/ai/chat-errors';

const databases:Database[]=[];
afterEach(()=>{for (const db of databases.splice(0)) db.close();});
function fixture(count=1) {
  const db=createTestDatabase();databases.push(db);
  const sdk=createExtensionSDK('knowledge-extractor',{database:db,namespace:'knowledge'});
  sdk.settings.get=((key:string)=>({enabled:true,maxSourcesPerRun:5,maxContentChars:12000,namespace:'knowledge',llmModel:'test-model'} as Record<string,unknown>)[key]) as typeof sdk.settings.get;
  for (let i=0;i<count;i++) sdk.ingest.sourceAndChunks({source:{id:`source-${i}`,uri:`file:///source-${i}.md`,title:`Source ${i}`,origin:'test',type:'note',hash:`v1-${i}`,created_at:100+i,updated_at:100+i},
    chunks:[{text_content:'Alice recommended SQLite for Atlas.'}]});
  const extraction={entities:[{key:'alice',name:'Alice',type:'Person'},{key:'sqlite',name:'SQLite',type:'Product'},{key:'atlas',name:'Atlas',type:'Project'}],
    claims:[{subject:'alice',predicate:'RECOMMENDS',object:'sqlite',context:'Atlas',confidence:0.9,evidence:[{chunkIndex:0,quote:'Alice recommended SQLite for Atlas.'}]}],
    events:[{key:'decision',name:'Atlas database recommendation',kind:'Recommendation',context:'Atlas',participants:[{entity:'alice',role:'recommender'},{entity:'sqlite',role:'choice'},{entity:'atlas',role:'project'}],
      evidence:[{chunkIndex:0,quote:'Alice recommended SQLite for Atlas.'}]}]};
  sdk.queryLLM=(async()=>JSON.stringify(extraction)) as unknown as typeof sdk.queryLLM;
  return {db,sdk,extraction};
}

function windowLimits(sdk: ReturnType<typeof createExtensionSDK>, maxSources = 5) {
  const get = sdk.settings.get.bind(sdk.settings);
  sdk.settings.get = ((key: string) => key === 'maxContentChars' ? 100
    : key === 'maxSourcesPerRun' ? maxSources : get(key)) as typeof sdk.settings.get;
}

it('digests selected sources through the normal pipeline without consuming unrelated backlog', async () => {
  const { sdk, db } = fixture(2);
  expect(await run(sdk, { sourceIds: ['source-0'] })).toMatchObject({ committed: 1 });
  expect(db.query('SELECT source_id FROM graph_source_digests').all()).toEqual([{ source_id: 'source-0' }]);
  expect(await run(sdk, { sourceIds: ['source-0'] })).toMatchObject({ committed: 0 });
  expect(await run(sdk, { sourceIds: ['source-1'] })).toMatchObject({ committed: 1 });
  await expect(run(sdk, { sourceIds: [] })).rejects.toThrow('nonempty source id');
});

it('processes the entire revision in bounded windows with correct Unicode evidence offsets', async () => {
  const { sdk, db } = fixture(0);
  windowLimits(sdk);
  const prefix = '😀'.repeat(50) + 'a'.repeat(50), quote = 'Bob chose SQLite.';
  sdk.ingest.sourceAndChunks({ source: { id: 'long', uri: 'file:///long.md', title: 'Long source', type: 'note', origin: 'test' },
    chunks: [{ text_content: prefix + quote + 'z'.repeat(100) }] });
  const revision = db.query<{ id: number }, []>('SELECT id FROM graph_source_revisions').get()!.id;
  let calls = 0;
  sdk.queryLLM = (async (prompt: string) => {
    calls++;
    const chunks = JSON.parse(prompt.split('Source chunks: ')[1]);
    expect(Array.from(chunks.map((chunk: any) => chunk.text_content).join('')).length).toBeLessThanOrEqual(100);
    return JSON.stringify(chunks.some((chunk: any) => chunk.text_content.includes(quote)) ? {
      entities: [{ key: 'bob', name: 'Bob', type: 'Person' }, { key: 'sqlite', name: 'SQLite', type: 'Product' }],
      claims: [{ subject: 'bob', predicate: 'CHOSE', object: 'sqlite', evidence: [{ chunkIndex: 0, quote }] }], events: [],
    } : { entities: [], claims: [], events: [] });
  }) as typeof sdk.queryLLM;
  expect((await run(sdk)).committed).toBe(1);
  expect(sdk.state.get(`extracted:${revision}`)).toBeNull();
  expect(JSON.parse(sdk.state.get(extractionCursorKey(revision))!)).toMatchObject({ offset: 150, codePointOffset: 100 });
  // Assignment can run between extraction windows and find no episode from the prefix.
  db.query("UPDATE graph_source_digests SET episode_state='none',signals_at=1 WHERE source_id='long'").run();
  expect((await run(sdk)).committed).toBe(1);
  const digest = db.query<{episode_state:string;signals_at:number|null;entity_ids:string}, []>(
    "SELECT episode_state,signals_at,entity_ids FROM graph_source_digests WHERE source_id='long'").get()!;
  expect(digest).toMatchObject({episode_state:'pending',signals_at:null});
  expect(JSON.parse(digest.entity_ids)).toHaveLength(2);
  const claim = sdk.graph.claims.list({ predicate: 'CHOSE' })[0];
  expect(sdk.graph.evidence.list(claim.id)[0]).toMatchObject({ quote, locator: { start: 150, end: 150 + quote.length } });
  expect(sdk.state.get(`extracted:${revision}`)).toBeNull();
  expect((await run(sdk)).committed).toBe(1);
  expect(sdk.state.get(`extracted:${revision}`)).toBe('complete');
  expect(sdk.state.get(extractionCursorKey(revision))).toBeNull();
  expect((await run(sdk)).committed).toBe(0);
  expect(calls).toBe(3);
});

it('recovers a partial window transaction without repeating chat or marking the remaining text complete', async () => {
  const { sdk, db, extraction } = fixture(0);
  windowLimits(sdk);
  sdk.ingest.sourceAndChunks({ source: { id: 'long', uri: 'file:///long.md', title: 'Long source', type: 'note', origin: 'test' },
    chunks: [{ text_content: 'Alice recommended SQLite for Atlas.' + 'x'.repeat(200) }] });
  const revision = db.query<{ id: number }, []>('SELECT id FROM graph_source_revisions').get()!.id;
  let calls = 0;
  sdk.queryLLM = (async () => { calls++; return JSON.stringify(extraction); }) as unknown as typeof sdk.queryLLM;
  const add = sdk.graph.claims.add.bind(sdk.graph.claims);
  sdk.graph.claims.add = () => { throw Error('Graph unavailable'); };
  await expect(run(sdk)).rejects.toThrow('Graph unavailable');
  expect(sdk.state.get(extractionCursorKey(revision))).toBeNull();
  sdk.graph.claims.add = add;
  expect((await recover(sdk)).committed).toBe(1);
  expect(calls).toBe(1);
  expect(sdk.state.get(extractionCursorKey(revision))).not.toBeNull();
  expect(sdk.state.get(`extracted:${revision}`)).toBeNull();
});

it('gives unprocessed sources a turn before continuing a long source', async () => {
  const { sdk } = fixture(2);
  windowLimits(sdk, 1);
  // Newest sources go first, so the long source would otherwise keep the turn.
  sdk.ingest.sourceAndChunks({ source: { id: 'source-0', uri: 'file:///source-0.md', title: 'Long source', type: 'note', origin: 'test', hash: 'long', updated_at:200 },
    chunks: [{ text_content: 'a'.repeat(300) }] });
  const prompts: string[] = [];
  sdk.queryLLM = (async (prompt: string) => { prompts.push(prompt); return '{"entities":[],"claims":[],"events":[]}'; }) as typeof sdk.queryLLM;
  await run(sdk);
  await run(sdk);
  expect(prompts[0]).toContain('Source title: "Long source"');
  expect(prompts[1]).toContain('Source title: "Source 1"');
});

it('gives other sources a turn after a source exhausts output validation retries', async () => {
  const {sdk,extraction}=fixture(2);windowLimits(sdk,1);
  sdk.queryLLM=(async (prompt:string|{messages:Array<{content:string}>})=> {
    expect(typeof prompt==='string' ? prompt : prompt.messages[0]!.content).toContain('Source title: "Source 1"');
    return '{"entities":[],"claims":[{}],"events":[]}';
  }) as unknown as typeof sdk.queryLLM;
  expect(await run(sdk)).toMatchObject({committed:0,rejected:1});
  sdk.queryLLM=(async (prompt:string)=> {
    expect(prompt).toContain('Source title: "Source 0"');
    return JSON.stringify(extraction);
  }) as typeof sdk.queryLLM;
  expect((await run(sdk)).committed).toBe(1);
});

it('completes every chat request before graph commits, grounds events and claims, and skips completed revisions',async()=> {
  const {sdk,extraction}=fixture(2);let chats=0;
  sdk.queryLLM=(async()=>{chats++;expect(sdk.graph.claims.list()).toHaveLength(0);return JSON.stringify(extraction);}) as unknown as typeof sdk.queryLLM;
  const add=sdk.graph.claims.add.bind(sdk.graph.claims);
  sdk.graph.claims.add=(input)=>{expect(chats).toBe(2);return add(input);};
  expect((await run(sdk)).committed).toBe(2);
  expect(sdk.graph.claims.list()).toHaveLength(10);
  expect(sdk.graph.claims.list().every(c=>c.status==='proposed')).toBe(true);
  expect(sdk.graph.claims.list().every(c=>c.method==='llm')).toBe(true);
  const claim=sdk.graph.claims.list({predicate:'RECOMMENDS'})[0];
  expect(sdk.graph.evidence.list(claim.id)[0]).toMatchObject({quote:'Alice recommended SQLite for Atlas.',model:'test-model',stale:false});
  expect(sdk.hasCheckpoints()).toBe(false);
  expect((await run(sdk)).committed).toBe(0);expect(chats).toBe(2);
  expect(sdk.graph.entities.resolve('Alice')).toHaveLength(2); // Name equality is not identity proof.
});

it('bounds extraction output and disables reasoning before requesting structured claims', async () => {
  const {sdk,extraction}=fixture();
  sdk.queryLLM=(async (_prompt: unknown, options: unknown)=> {
    expect(options).toMatchObject({maxTokens:8192,reasoningEffort:'none',maxThinkingTokens:null});
    return JSON.stringify(extraction);
  }) as unknown as typeof sdk.queryLLM;
  expect((await run(sdk)).committed).toBe(1);
});

it('retries invalid model output with feedback and commits only grounded corrections', async () => {
  const {sdk,extraction}=fixture();let calls=0;
  sdk.queryLLM=(async (input: unknown)=> {
    calls++;
    if(calls===1) return JSON.stringify({...extraction,claims:[{...extraction.claims[0],value:null}]});
    expect(input).toMatchObject({messages:[{role:'user'},{role:'assistant'},{role:'user'}]});
    const messages=(input as {messages:Array<{content:string}>}).messages;
    expect(messages[1].content).toContain('"value":null');
    expect(messages[2].content).toContain('Your previous output failed validation');
    expect(sdk.graph.claims.list()).toHaveLength(0);
    return JSON.stringify(extraction);
  }) as unknown as typeof sdk.queryLLM;
  expect((await run(sdk)).committed).toBe(1);
  expect(calls).toBe(2);
  expect(sdk.state.getAll().some(row=>row.state_key.startsWith('extraction-rejected:'))).toBe(false);
});

it('bounds invalid-output retries and retains the rejected response without advancing progress', async () => {
  const {sdk}=fixture();let calls=0;
  sdk.queryLLM=(async ()=> {calls++;return '{"entities":[],"claims":[{}],"events":[]}';}) as unknown as typeof sdk.queryLLM;
  expect(await run(sdk)).toMatchObject({committed:0,rejected:1});
  expect(calls).toBe(3);
  expect(sdk.graph.claims.list()).toHaveLength(0);
  expect(sdk.hasCheckpoints()).toBe(false);
  expect(sdk.state.getAll().some(row=>row.state_key.startsWith('extracted:'))).toBe(false);
  expect(JSON.parse(sdk.state.getAll().find(row=>row.state_key.startsWith('extraction-rejected:'))!.value).raw).toContain('claims');
});

it('retains earlier chat outputs after a later model failure and recovers without rerunning chat',async()=> {
  const {sdk,extraction}=fixture(2);let chats=0;
  sdk.queryLLM=(async()=>{if (++chats===2) throw new Error('Model offline');return JSON.stringify(extraction);}) as unknown as typeof sdk.queryLLM;
  await expect(run(sdk)).rejects.toThrow('Model offline');
  expect(sdk.graph.claims.list()).toHaveLength(0);expect(sdk.checkpoint.getQueue()).toHaveLength(1);
  expect((await recover(sdk)).committed).toBe(1);expect(chats).toBe(2);
  sdk.queryLLM=(async()=>{chats++;return JSON.stringify(extraction);}) as unknown as typeof sdk.queryLLM;
  expect((await run(sdk)).committed).toBe(1);expect(chats).toBe(3);
});

it('commits valid windows in a batch containing a rejected extraction', async () => {
  const {sdk,extraction}=fixture(2);
  sdk.queryLLM=(async (input: unknown)=> {
    const prompt=typeof input==='string' ? input : JSON.stringify(input);
    return prompt.includes('Source 0') ? '{"entities":[],"claims":[{}],"events":[]}' : JSON.stringify(extraction);
  }) as unknown as typeof sdk.queryLLM;
  expect(await run(sdk)).toMatchObject({committed:1,rejected:1});
  expect(sdk.graph.claims.list()).toHaveLength(5);
  expect(sdk.hasCheckpoints()).toBe(false);
  expect(sdk.state.getAll().filter(row=>row.state_key.startsWith('extracted:'))).toHaveLength(1);
});

it('retains token-truncated output without retrying it or blocking valid batch members', async () => {
  const {sdk,extraction}=fixture(2);let calls=0;
  sdk.queryLLM=(async (prompt:string)=> {
    calls++;
    if(prompt.includes('Source 0')) throw new TruncatedChatCompletionError('test://chat','{"entities":[');
    return JSON.stringify(extraction);
  }) as unknown as typeof sdk.queryLLM;
  expect(await run(sdk)).toMatchObject({committed:1,rejected:1});
  expect(calls).toBe(2);
  expect(sdk.hasCheckpoints()).toBe(false);
  expect(sdk.state.getAll().filter(row=>row.state_key.startsWith('extracted:'))).toHaveLength(1);
  const rejected=JSON.parse(sdk.state.getAll().find(row=>row.state_key.startsWith('extraction-rejected:'))!.value);
  expect(rejected.raw).toBe('{"entities":[');
  expect(rejected.error).toContain('truncated by its token limit');
});

it('rolls back claims, events, progress, and checkpoint resolution together when graph commit fails',async()=> {
  const {sdk}=fixture(2);const add=sdk.graph.claims.add.bind(sdk.graph.claims);let writes=0;
  sdk.graph.claims.add=(input)=>{if (++writes===5) throw new Error('Storage unavailable');return add(input);};
  await expect(run(sdk)).rejects.toThrow('Storage unavailable');
  expect(sdk.graph.claims.list()).toHaveLength(0);expect(sdk.graph.entities.resolve('Alice')).toHaveLength(0);
  expect(sdk.checkpoint.getQueue()).toHaveLength(2);
  expect(sdk.state.getAll().filter(s=>s.state_key.startsWith('extracted:'))).toHaveLength(0);
  sdk.graph.claims.add=add;
  expect((await recover(sdk)).committed).toBe(2);expect(sdk.hasCheckpoints()).toBe(false);
});

it('never writes an ungrounded claim; after retries it keeps only the grounded parts of the window',async()=> {
  const {sdk,extraction}=fixture();
  extraction.claims[0].evidence[0].quote='Bob chose PostgreSQL.';
  let calls=0;
  sdk.queryLLM=(async()=>{calls++;return JSON.stringify(extraction);}) as unknown as typeof sdk.queryLLM;
  expect(await run(sdk)).toMatchObject({committed:1,rejected:0});
  expect(calls).toBe(3);
  expect(sdk.hasCheckpoints()).toBe(false);
  expect(sdk.graph.claims.list({predicate:'RECOMMENDS'})).toHaveLength(0);
  expect(sdk.graph.claims.list({predicate:'EVENT_KIND'})).toHaveLength(1);
  // A response with nothing valid left is still rejected without progress.
  const empty=fixture();
  empty.sdk.queryLLM=(async()=>JSON.stringify({entities:[],claims:[{...extraction.claims[0]}],events:[]})) as unknown as typeof sdk.queryLLM;
  expect(await run(empty.sdk)).toMatchObject({committed:0,rejected:1});
  expect(empty.sdk.state.getAll().some(row=>row.state_key.startsWith('extraction-rejected:'))).toBe(true);
});

it('keeps checkpoint evidence on the original revision when a source changes during chat',async()=> {
  const {db,sdk,extraction}=fixture();
  const originalHash=db.query<{hash:string},[string]>("SELECT hash FROM graph_source_revisions WHERE source_id=? ORDER BY id DESC LIMIT 1").get('source-0')!.hash;
  sdk.queryLLM=(async()=> {
    sdk.ingest.sourceAndChunks({source:{id:'source-0',uri:'file:///source-0.md',title:'Changed',origin:'test',type:'note',hash:'v2'},
      chunks:[{text_content:'Bob recommended PostgreSQL.'}]});
    return JSON.stringify(extraction);
  }) as unknown as typeof sdk.queryLLM;
  await run(sdk);
  const claims=sdk.graph.claims.list();expect(claims.every(c=>c.status==='stale')).toBe(true);
  expect(sdk.graph.evidence.list(claims[0].id)[0]).toMatchObject({sourceHash:originalHash,quote:'Alice recommended SQLite for Atlas.',stale:true});
});

it('does not adopt model-supplied review status, namespace, or dependency IDs',()=> {
  const {extraction}=fixture();
  const parsed=parseExtraction(JSON.stringify({...extraction,claims:[{...extraction.claims[0],status:'accepted',namespace:'foreign',dependsOn:['invented'] }]}));
  expect(parsed.claims[0]).not.toHaveProperty('status');expect(parsed.claims[0]).not.toHaveProperty('dependsOn');
  expect(()=>parseExtraction(JSON.stringify({...extraction,claims:[{...extraction.claims[0],object:'missing'}]}))).toThrow('Invalid extracted claim');
});

it('uses persistent leases to exclude concurrent runs and allows expired ownership to recover',async()=> {
  const {db,sdk}=fixture();
  const lease=acquireTaskLease(db,sdk.extensionId,'knowledge-extractor-lease')!;
  expect(await run(sdk)).toMatchObject({committed:0,busy:true});
  db.query("UPDATE extension_state SET updated_at=0 WHERE state_key='knowledge-extractor-lease'").run();
  const next=acquireTaskLease(db,sdk.extensionId,'knowledge-extractor-lease')!;
  expect(next).not.toBeNull();expect(()=>lease.renew()).toThrow('lost');
  lease.release();expect(sdk.state.get('knowledge-extractor-lease')).not.toBeNull();
  next.release();expect((await run(sdk)).committed).toBe(1);
});

it('drops a datatype the value contradicts instead of failing the commit', () => {
  const {extraction}=fixture();
  const parsed=parseExtraction(JSON.stringify({...extraction,claims:[{...extraction.claims[0],object:undefined,value:'three weeks',datatype:'number'}]}));
  expect(parsed.claims[0]!.datatype).toBeUndefined();
  expect(consistentDatatype<{value:unknown;datatype?:string}>({value:'3',datatype:'number'})).toEqual({value:'3'});
  expect(consistentDatatype({value:3,datatype:'number'})).toEqual({value:3,datatype:'number'});
});

it('ignores literal datatypes on entity relationships during extraction', async () => {
  const {sdk,extraction}=fixture();
  const response={...extraction,claims:[{...extraction.claims[0],datatype:'number'}]};
  expect(parseExtraction(JSON.stringify(response)).claims[0]!.datatype).toBeUndefined();
  sdk.queryLLM=(async()=>JSON.stringify(response)) as unknown as typeof sdk.queryLLM;
  expect(await run(sdk)).toMatchObject({committed:1});
  expect(sdk.graph.claims.list({predicate:'RECOMMENDS'})[0]).toMatchObject({object:expect.any(Number),datatype:undefined});
});

it('recovers saved entity relationships with literal datatypes without repeating model calls', async () => {
  const {sdk}=fixture(2);
  const add=sdk.graph.claims.add.bind(sdk.graph.claims);
  sdk.graph.claims.add=()=>{throw Error('Storage interrupted');};
  await expect(run(sdk)).rejects.toThrow('Storage interrupted');
  const checkpoint=sdk.checkpoint.getQueue<any>()[0]!;
  checkpoint.data.extraction.claims[0].datatype='number';
  sdk.checkpoint.save(checkpoint.data,{id:checkpoint.id,key:checkpoint.key});
  sdk.graph.claims.add=add;
  sdk.queryLLM=(()=>{throw Error('Recovery must use saved outputs');}) as typeof sdk.queryLLM;
  expect(await recover(sdk)).toMatchObject({committed:2});
  expect(sdk.graph.claims.list({predicate:'RECOMMENDS'})).toHaveLength(2);
  expect(sdk.hasCheckpoints()).toBe(false);
});
