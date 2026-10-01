import { afterEach, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { run } from '../extensions/knowledge-extractor';
import { run as recover } from '../extensions/knowledge-extractor/recover';
import { parseExtraction } from '../extensions/knowledge-extractor/parse';
import { acquireTaskLease } from '../lib/task-lease';

const databases:Database[]=[];
afterEach(()=>{for (const db of databases.splice(0)) db.close();});
function fixture(count=1) {
  const db=createTestDatabase();databases.push(db);
  const sdk=createExtensionSDK('knowledge-extractor',{database:db,namespace:'knowledge'});
  sdk.settings.get=((key:string)=>({enabled:true,maxSourcesPerRun:5,maxContentChars:12000,namespace:'knowledge',llmModel:'test-model'} as Record<string,unknown>)[key]) as typeof sdk.settings.get;
  for (let i=0;i<count;i++) sdk.ingest.sourceAndChunks({source:{id:`source-${i}`,uri:`file:///source-${i}.md`,title:`Source ${i}`,origin:'test',type:'note',hash:`v1-${i}`},
    chunks:[{text_content:'Alice recommended SQLite for Atlas.',embedding:[1,0,0,0]}]});
  const extraction={entities:[{key:'alice',name:'Alice',type:'Person'},{key:'sqlite',name:'SQLite',type:'Product'},{key:'atlas',name:'Atlas',type:'Project'}],
    claims:[{subject:'alice',predicate:'RECOMMENDS',object:'sqlite',context:'Atlas',confidence:0.9,evidence:[{chunkIndex:0,quote:'Alice recommended SQLite for Atlas.'}]}],
    events:[{key:'decision',name:'Atlas database recommendation',kind:'Recommendation',context:'Atlas',participants:[{entity:'alice',role:'recommender'},{entity:'sqlite',role:'choice'},{entity:'atlas',role:'project'}],
      evidence:[{chunkIndex:0,quote:'Alice recommended SQLite for Atlas.'}]}]};
  sdk.queryLLM=(async()=>JSON.stringify(extraction)) as unknown as typeof sdk.queryLLM;
  return {db,sdk,extraction};
}

it('completes every chat request before graph commits, grounds events and claims, and skips completed revisions',async()=> {
  const {sdk,extraction}=fixture(2);let chats=0;
  sdk.queryLLM=(async()=>{chats++;expect(sdk.graph.claims.list()).toHaveLength(0);return JSON.stringify(extraction);}) as unknown as typeof sdk.queryLLM;
  const add=sdk.graph.claims.add.bind(sdk.graph.claims);
  sdk.graph.claims.add=(input)=>{expect(chats).toBe(2);return add(input);};
  sdk.embed=(()=>{throw new Error('Extraction must reuse existing embeddings');}) as typeof sdk.embed;
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

it('retains earlier chat outputs after a later model failure and recovers without rerunning chat',async()=> {
  const {sdk,extraction}=fixture(2);let chats=0;
  sdk.queryLLM=(async()=>{if (++chats===2) throw new Error('Model offline');return JSON.stringify(extraction);}) as unknown as typeof sdk.queryLLM;
  await expect(run(sdk)).rejects.toThrow('Model offline');
  expect(sdk.graph.claims.list()).toHaveLength(0);expect(sdk.checkpoint.getQueue()).toHaveLength(1);
  expect((await recover(sdk)).committed).toBe(1);expect(chats).toBe(2);
  sdk.queryLLM=(async()=>{chats++;return JSON.stringify(extraction);}) as unknown as typeof sdk.queryLLM;
  expect((await run(sdk)).committed).toBe(1);expect(chats).toBe(3);
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

it('rejects ungrounded quotes before saving checkpoints or writing knowledge',async()=> {
  const {sdk,extraction}=fixture();
  extraction.claims[0].evidence[0].quote='Bob chose PostgreSQL.';
  sdk.queryLLM=(async()=>JSON.stringify(extraction)) as unknown as typeof sdk.queryLLM;
  await expect(run(sdk)).rejects.toThrow('absent');
  expect(sdk.hasCheckpoints()).toBe(false);expect(sdk.graph.claims.list()).toHaveLength(0);
});

it('keeps checkpoint evidence on the original revision when a source changes during chat',async()=> {
  const {sdk,extraction}=fixture();
  sdk.queryLLM=(async()=> {
    sdk.ingest.sourceAndChunks({source:{id:'source-0',uri:'file:///source-0.md',title:'Changed',origin:'test',type:'note',hash:'v2'},
      chunks:[{text_content:'Bob recommended PostgreSQL.',embedding:[1,0,0,0]}]});
    return JSON.stringify(extraction);
  }) as unknown as typeof sdk.queryLLM;
  await run(sdk);
  const claims=sdk.graph.claims.list();expect(claims.every(c=>c.status==='stale')).toBe(true);
  expect(sdk.graph.evidence.list(claims[0].id)[0]).toMatchObject({sourceHash:'v1-0',quote:'Alice recommended SQLite for Atlas.',stale:true});
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
