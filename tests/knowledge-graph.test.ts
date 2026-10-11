import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createExtensionSDK, createMessageBus } from '../sdk';
import { GraphIngestor } from '../sdk/graph';
import { ensureGraphSchema } from '../lib/graph/schema';
import { createTestDatabase } from './fixtures/database';
import { registerMessages } from '../extensions/knowledge-graph';
import { commitLinksToGraph } from '../extensions/source-linker/process-links';
import { startVisualizerServer } from '../visualizer/server';

const databases:Database[]=[];
afterEach(()=>{for (const db of databases.splice(0)) db.close();});
function fixture() {
  const db=createTestDatabase();databases.push(db);
  const sdk=createExtensionSDK('knowledge-test',{database:db,namespace:'knowledge'});
  const a=sdk.graph.entities.create({name:'Alice',type:'Person'});
  const b=sdk.graph.entities.create({name:'Atlas',type:'Project'});
  return {db,sdk,graph:sdk.graph,a,b};
}
function ingest(sdk:ReturnType<typeof createExtensionSDK>,text='Alice leads Atlas.',hash='v1') {
  return sdk.ingest.sourceAndChunks({source:{id:'source-1',uri:'file:///atlas.md',title:'Atlas',origin:'test',type:'note',hash},
    chunks:[{text_content:text}]});
}

describe('Knowledge graph',()=> {
  it('migrates legacy topology once while preserving node IDs and unknown confidence',()=> {
    const db=new Database(':memory:');databases.push(db);
    db.run(`CREATE TABLE entities(id INTEGER PRIMARY KEY,namespace TEXT,name TEXT,type TEXT,UNIQUE(namespace,name));
      CREATE TABLE edges(source_entity_id INTEGER,target_entity_id INTEGER,relation TEXT,weight REAL,metadata TEXT);
      INSERT INTO entities VALUES(41,'notes','A','Concept'),(42,'notes','B','Concept');
      INSERT INTO edges VALUES(41,42,'REFERENCES',0.7,'{"reason":"Original connection"}'),(41,42,'RELATES_TO',1,'A legacy reason');`);
    ensureGraphSchema(db);ensureGraphSchema(db);
    const graph=new GraphIngestor('notes',db);
    expect(graph.entities.get(41).stableId).toBeTruthy();
    expect(graph.claims.list()).toHaveLength(2);
    expect(graph.claims.list()[0]).toMatchObject({subject:41,object:42,strength:0.7,method:'legacy',status:'accepted'});
    expect(graph.claims.list()[0].confidence).toBeUndefined();
    expect(graph.claims.list()[0].qualifiers).toEqual({reason:'Original connection'});
    expect(graph.claims.list()[1].qualifiers).toEqual({legacyMetadata:'A legacy reason'});
    expect(graph.inspect(graph.claims.list()[0].id).evidence).toEqual([]);
  });

  it('keeps names ambiguous, supports scoped aliases, and reversibly merges identities',()=> {
    const {graph,a}=fixture();
    const other=graph.entities.create({name:'Alice',type:'Person',aliases:[{name:'A.',scope:'team:two'}]});
    expect(graph.entities.resolve('Alice')).toHaveLength(2);
    expect(graph.entities.resolve('A.','team:two')[0].id).toBe(other.id);
    graph.entities.rename(a.id,'Alice Smith');
    expect(graph.entities.get(a.id).stableId).toBe(a.stableId);
    const change=graph.entities.merge(other.id,a.id,'Same person, confirmed by user');
    expect(graph.entities.resolve('Alice')).toHaveLength(1);
    expect(()=>graph.entities.merge(a.id,other.id,'cycle')).toThrow();
    graph.entities.unmerge(change);
    expect(graph.entities.resolve('Alice')).toHaveLength(2);
    expect(graph.entities.inspect(other.id).merges[0].undone_at).not.toBeNull();
    expect(()=>graph.entities.create({name:'Duplicate',type:'Person',externalIds:{email:'alice@example.test'}})).not.toThrow();
    expect(()=>graph.entities.create({name:'Impostor',type:'Person',externalIds:{email:'alice@example.test'}})).toThrow('External identifier');
  });

  it('preserves independent assertions, typed measurements, explicit negation, and context',()=> {
    const {graph,a,b}=fixture();
    const first=graph.claims.add({subject:a.id,predicate:'LEADS',object:b.id,context:'team:one',confidence:0.8});
    graph.claims.add({subject:a.id,predicate:'LEADS',object:b.id,context:'team:one',polarity:-1});
    graph.claims.add({subject:a.id,predicate:'LEADS',object:b.id,context:'team:two',polarity:-1});
    graph.claims.add({subject:b.id,predicate:'LATENCY',value:12.5,datatype:'number',unit:'ms',qualifiers:{environment:'local'}});
    expect(graph.claims.list()).toHaveLength(4);
    expect(graph.conflicts.find().conflicts).toHaveLength(1);
    expect(graph.conflicts.find({context:'team:two'}).conflicts).toHaveLength(0);
    expect(()=>graph.claims.add({...first,value:'illegal'})).toThrow('exactly one');
    expect(()=>graph.claims.add({...first})).toThrow('already exists');
    expect(()=>graph.claims.add({subject:b.id,predicate:'LATENCY',value:NaN})).toThrow('finite');
    expect(()=>graph.claims.add({subject:b.id,predicate:'LATENCY',value:'12',datatype:'number'})).toThrow('datatype');
  });

  it('validates relation types, inverse semantics, and cardinality within overlapping periods',()=> {
    const {graph,a,b}=fixture();
    graph.relations.define({name:'LEADS',sourceTypes:['Person'],targetTypes:['Project'],inverse:'LED_BY',maxTargets:1});
    expect(graph.relations.reciprocal('LEADS')).toBe('LED_BY');
    expect(graph.relations.reciprocal('UNKNOWN')).toBeUndefined();
    expect(()=>graph.claims.add({subject:b.id,predicate:'LEADS',object:a.id})).toThrow('subject type');
    const other=graph.entities.create({name:'Boreal',type:'Project'});
    graph.claims.add({subject:a.id,predicate:'LEADS',object:b.id,status:'accepted',validFrom:100,validTo:200});
    graph.claims.add({subject:a.id,predicate:'LEADS',object:other.id,status:'accepted',validFrom:200,validTo:300});
    const competing=graph.claims.add({subject:a.id,predicate:'LEADS',object:other.id,validFrom:150,validTo:190});
    expect(()=>graph.lifecycle.review(competing.id,'accepted','user','Accept')).toThrow('cardinality');
    expect(graph.claims.get(competing.id).status).toBe('proposed');
    expect(graph.conflicts.find().conflicts).toHaveLength(1);
  });

  it('stores separate event occurrences and ordered participant roles transactionally',()=> {
    const {graph,a,b}=fixture();
    const input={name:'Atlas planning',kind:'Meeting',occurredFrom:1000,occurredTo:1000,participants:[
      {entity:a.id,role:'organizer',position:0},{entity:b.id,role:'project',position:1}]};
    const first=graph.events.create(input),second=graph.events.create(input);
    expect(first.entity.id).not.toBe(second.entity.id);
    expect(first.participants.map(p=>p.role)).toEqual(['organizer','project']);
    expect(graph.events.list({from:1000,to:1000})).toHaveLength(2);
    expect(graph.events.list({from:1001})).toHaveLength(0);
    graph.lifecycle.review(first.claimId,'accepted','user','Meeting confirmed');
    expect(graph.events.list({statuses:['accepted']})).toHaveLength(1);
    const count=graph.claims.list().length;
    expect(()=>graph.events.create({...input,participants:[{entity:9999,role:'organizer'}]})).toThrow('Unknown graph entity');
    expect(graph.claims.list()).toHaveLength(count);
  });

  it('retains exact evidence across source replacement and invalidates all dependent conclusions',()=> {
    const {sdk,graph,a,b,db}=fixture();ingest(sdk);
    const parent=graph.claims.add({subject:a.id,predicate:'LEADS',object:b.id,status:'accepted',
      evidence:[{sourceId:'source-1',chunkIndex:1,quote:'Alice leads Atlas.',locator:{start:0,end:18}}]});
    const child=graph.claims.add({subject:b.id,predicate:'HAS_LEADER',value:true,status:'accepted',dependsOn:[parent.id]});
    const grandchild=graph.claims.add({subject:b.id,predicate:'IS_STAFFED',value:true,status:'accepted',dependsOn:[child.id]});
    ingest(sdk); // Same revision does not invalidate claims.
    expect(graph.claims.get(parent.id).status).toBe('accepted');
    ingest(sdk,'Bob leads Atlas.','v2');
    expect([parent,child,grandchild].map(c=>graph.claims.get(c.id).status)).toEqual(['stale','stale','stale']);
    const evidence=graph.evidence.list(parent.id)[0];
    expect(evidence.quote).toBe('Alice leads Atlas.');expect(evidence.stale).toBe(true);
    expect(graph.evidence.revision(evidence.revisionId).chunks).toContainEqual(expect.objectContaining({text_content:'Alice leads Atlas.'}));
    expect(()=>graph.lifecycle.review(child.id,'accepted','user','Retry')).toThrow('dependencies');
    db.query("DELETE FROM sources WHERE id='source-1'").run();
    expect(graph.evidence.list(parent.id)[0].quote).toBe('Alice leads Atlas.');
  });

  it('rolls back an entire claim batch when evidence spans do not match',()=> {
    const {sdk,graph,a,b}=fixture();ingest(sdk);
    expect(()=>graph.ingestClaims([
      {subject:a.id,predicate:'LEADS',object:b.id},
      {subject:a.id,predicate:'LEADS',object:b.id,evidence:[{sourceId:'source-1',chunkIndex:1,quote:'Bob',locator:{start:0,end:3}}]},
    ])).toThrow('does not match');
    expect(graph.claims.list()).toHaveLength(0);
  });

  it('keeps review history and answers validity and historical knowledge queries',async()=> {
    const {graph,a,b}=fixture();
    const claim=graph.claims.add({subject:a.id,predicate:'LEADS',object:b.id,validFrom:100,validTo:200});
    const before=claim.recordedAt;await Bun.sleep(5);
    graph.lifecycle.review(claim.id,'accepted','user','Confirmed in the document');
    expect(graph.claims.list({at:150,statuses:['accepted']})).toHaveLength(1);
    expect(graph.claims.list({at:200})).toHaveLength(0);
    expect(graph.claims.list({knownAt:before,statuses:['accepted']})).toHaveLength(0);
    expect(graph.claims.list({knownAt:before,statuses:['proposed']})[0].status).toBe('proposed');
    const acceptedAt=Date.now();await Bun.sleep(5);
    graph.lifecycle.review(claim.id,'retracted','user','Source corrected');
    expect(graph.claims.list({knownAt:acceptedAt,statuses:['accepted']})[0].status).toBe('accepted');
    expect(graph.inspect(claim.id).reviews).toHaveLength(2);
    expect(graph.inspect(claim.id).history).toHaveLength(3);
  });

  it('bounds cyclic traversal, follows direction/context, and explains paths through merged entities',()=> {
    const {graph,a,b}=fixture();
    const c=graph.entities.create({name:'Charlie',type:'Person'});
    const first=graph.claims.add({subject:a.id,predicate:'KNOWS',object:c.id,status:'accepted',context:'work'});
    const second=graph.claims.add({subject:c.id,predicate:'LEADS',object:b.id,status:'accepted',context:'work'});
    graph.claims.add({subject:b.id,predicate:'REFERENCES',object:a.id,status:'accepted',context:'work'});
    graph.claims.add({subject:a.id,predicate:'IGNORED',object:b.id,context:'personal'});
    const result=graph.query.path({start:a.id,target:b.id,maxDepth:2,context:'work'});
    expect(result.path?.claimIds).toEqual([first.id,second.id]);
    expect(graph.query.traverse({start:a.id,maxNodes:1,context:'work'}).truncated).toBe(true);
    expect(graph.query.traverse({start:b.id,direction:'in',maxDepth:1,context:'work'}).entities.map(e=>e.id)).toContain(c.id);
    const alias=graph.entities.create({name:'Charles',type:'Person'});
    graph.claims.add({subject:alias.id,predicate:'LEADS',object:b.id,status:'accepted',context:'work'});
    graph.entities.merge(alias.id,c.id,'Same person');
    expect(graph.query.traverse({start:alias.id,context:'work'}).entities.map(e=>e.id)).toContain(b.id);
    expect(()=>graph.query.traverse({start:a.id,maxDepth:100})).toThrow('budget');
  });

  it('derives only declared transitive relations with overlapping intervals and dependency lineage',()=> {
    const {graph,a,b}=fixture();
    const c=graph.entities.create({name:'Collection',type:'Concept'});
    const first=graph.claims.add({subject:a.id,predicate:'PART_OF',object:b.id,status:'accepted',validFrom:100,validTo:250});
    graph.claims.add({subject:b.id,predicate:'PART_OF',object:c.id,status:'accepted',validFrom:200,validTo:300});
    const inferred=graph.inference.transitive('PART_OF','knowledge');
    expect(inferred.claimIds).toHaveLength(1);
    expect(graph.claims.get(inferred.claimIds[0])).toMatchObject({subject:a.id,object:c.id,validFrom:200,validTo:250,method:'rule:transitive'});
    expect(graph.inference.transitive('PART_OF','knowledge').claimIds).toHaveLength(0);
    graph.lifecycle.review(first.id,'retracted','user','Not correct');
    expect(graph.claims.get(inferred.claimIds[0]).status).toBe('stale');
    expect(()=>graph.inference.transitive('RELATES_TO','knowledge')).toThrow('not declared');
  });

  it('exposes graph operations through typed messages',async()=> {
    const {db,a,b}=fixture();const bus=createMessageBus();
    const owner=createExtensionSDK('knowledge-graph',{database:db,namespace:'knowledge',messageBus:bus});
    registerMessages(owner);
    const sender=createExtensionSDK('other',{database:db,messageBus:bus});
    const result=await sender.messages.request('graph:ingest-claims',{claims:[{subject:a.id,predicate:'LEADS',object:b.id}]});
    expect(result.claims).toHaveLength(1);
    await sender.messages.request('graph:review',{claimId:result.claims[0].id,status:'accepted',actor:'user',reason:'Confirmed'});
    expect((await sender.messages.request('graph:query',{start:a.id})).entities).toHaveLength(2);
    owner.messages.dispose();sender.messages.dispose();
  });

  it('expands text search with graph paths and saved supporting passages without an LLM',async()=> {
    const {sdk,graph,a,b}=fixture();ingest(sdk);
    graph.claims.add({subject:a.id,predicate:'LEADS',object:b.id,status:'accepted',evidence:[{sourceId:'source-1',chunkIndex:1,quote:'Alice leads Atlas.'}]});
    const result=await sdk.search.graph({query:'Alice',mode:'bm25',graph:{maxDepth:1}});
    expect(result.results).toHaveLength(2);
    expect(result.neighborhoods.length).toBeGreaterThan(0);
    expect(result.relatedPassages.some(passage => passage.text === 'Alice leads Atlas.')).toBe(true);
    expect(result.evidence[0].quote).toBe('Alice leads Atlas.');
  });

  it('keeps unknown directional source links one-way and uses known inverse labels',()=> {
    const {sdk,graph}=fixture();
    const link={sourceIdA:'a',sourceTitleA:'A',sourceIdB:'b',sourceTitleB:'B',relation:'EXPANDS_UPON',reason:'Expansion',weight:0.9,textScore:0.8,entityResolutions:[]};
    expect(commitLinksToGraph([link],sdk)).toBe(2);
    expect(graph.claims.list().map(c=>c.predicate)).toContain('EXPANDED_BY');
    expect(commitLinksToGraph([{...link,relation:'CUSTOM_DIRECTIONAL'}],sdk)).toBe(1);
  });

  it('serves inspections and reviews locally and rejects cross-origin corrections',async()=> {
    const {sdk,graph,a,b}=fixture();
    const claim=graph.claims.add({subject:a.id,predicate:'LEADS',object:b.id});
    const server=startVisualizerServer(0,sdk),base=`http://127.0.0.1:${server.port}`;
    try {
      const response=await fetch(`${base}/api/knowledge/inspect?id=${claim.id}`);
      expect((await response.json()).claim.id).toBe(claim.id);
      const body=JSON.stringify({id:claim.id,status:'accepted',actor:'user',reason:'Verified'});
      const denied=await fetch(`${base}/api/knowledge/review`,{method:'POST',headers:{Origin:'https://evil.test','Content-Type':'application/json'},body});
      expect(denied.status).toBe(403);expect(graph.claims.get(claim.id).status).toBe('proposed');
      const saved=await fetch(`${base}/api/knowledge/review`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body});
      expect(saved.status).toBe(200);expect(graph.claims.get(claim.id).status).toBe('accepted');
      expect((await fetch(`${base}/api/graph?at=invalid`)).status).toBe(400);
    } finally {server.stop(true);}
  });
});
