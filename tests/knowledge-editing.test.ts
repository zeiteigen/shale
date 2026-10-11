import { afterEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestDatabase } from './fixtures/database';
import { createExtensionSDK } from '../sdk';
import { createKnowledgeGraphMcpServer } from '../mcp/server';
import type { MutationName, MutationArgs } from '../sdk/knowledge/schemas';
import { recordVersion } from '../sdk/knowledge/version';
import { commitNote } from '../extensions/obsidian/commit';
import { finalizeHistoryBatch } from '../extensions/browser/history-ingest';
import { processBookmarksBatch } from '../extensions/browser/catalog-ingest';

const databases:Database[]=[];
afterEach(()=>{for(const db of databases.splice(0)) db.close();});
function setup() {
  const db=createTestDatabase();databases.push(db);
  const sdk=createExtensionSDK('editing-tests',{database:db,namespace:'knowledge'});
  const edit=async <N extends MutationName>(name:N,args:MutationArgs<N>)=>{
    const response=await sdk.knowledge.mutate(name,args,{actor:'test-agent',reason:'Correct knowledge from verified evidence'}) as any;
    return response.operations[0].result as any;
  };
  const source=async(id='source',text='original evidence text')=>edit('add_source',{id,title:id,uri:`test://${id}`,text});
  const entity=(name:string,type='Concept')=>sdk.graph.entities.create({name,type});
  const claim=(subject:number,value:string,status:'accepted'|'proposed'='accepted')=>sdk.graph.claims.add({subject,predicate:'FACT',value,status});
  return {db,sdk,edit,source,entity,claim};
}

describe('Knowledge editing transactions',()=>{
  it('previews without writes or model calls, applies local refs, and retries exactly once',async()=>{
    const {db,sdk}=setup();
    const input={actor:'curator',reason:'Add documented project ownership',requestId:'batch-once',operations:[
      {type:'append_graph',args:{entities:[{ref:'p',name:'Project',type:'Project'},{ref:'o',name:'Owner',type:'Person'}],
        claims:[{subject:'@o',object:'@p',predicate:'OWNS',status:'accepted'}]}},
      {type:'connect_entities',args:{subject:'@p',object:'@o',predicate:'CONTACT',status:'proposed'}},
    ]};
    const epoch=recordVersion(db,'database','*');
    const preview=await sdk.knowledge.preview(input) as any;
    expect(preview.preview).toBe(true);expect(preview.operations).toHaveLength(2);
    expect(db.query('SELECT * FROM entities').all()).toHaveLength(0);
    expect(recordVersion(db,'database','*')).toBe(epoch);
    const result=await sdk.knowledge.apply(input) as any;
    expect(result.entityRefs.p).toBeGreaterThan(0);
    expect(await sdk.knowledge.apply(input)).toEqual(result);
    expect(db.query('SELECT * FROM graph_changes').all()).toHaveLength(1);
    expect(db.query('SELECT * FROM graph_claims').all()).toHaveLength(2);
    expect(db.query('SELECT * FROM edges').all()).toHaveLength(2);
    await expect(sdk.knowledge.apply({...input,reason:'different edit'})).rejects.toThrow('different change');
    expect((sdk.knowledge.history(result.changeId) as any).actor).toBe('curator');
    expect((sdk.knowledge.history(result.changeId) as any).operations.operations).toHaveLength(2);
    expect((sdk.knowledge.history(result.changeId) as any).result).toEqual(result);
  });

  it('rolls back whole mixed batches while applying ordered source edits',async()=>{
    const {db,sdk}=setup();
    const operations=[{type:'add_source',args:{id:'new',title:'New',uri:'test://new',text:'one'}},
      {type:'add_chunk',args:{sourceId:'new',text:'two'}},
      {type:'remove_source',args:{sourceId:'new'}},
      {type:'restore_source',args:{sourceId:'new'}}];
    const preview=await sdk.knowledge.preview({reason:'review text',operations}) as any;
    expect(preview.preview).toBe(true);
    expect(db.query('SELECT * FROM graph_source_revisions').all()).toHaveLength(0);
    await sdk.knowledge.apply({reason:'commit text',operations});
    const liveChunks=db.query<{chunk_index:number;chunk_type:string;text_content:string}, []>('SELECT chunk_index,chunk_type,text_content FROM chunks ORDER BY chunk_index').all();
    expect(liveChunks).toHaveLength(3);
    expect(liveChunks[0]).toMatchObject({chunk_index:0,chunk_type:'synthetic'});
    expect(liveChunks[0]!.text_content).toContain('one');
    expect(liveChunks.slice(1).map(chunk=>chunk.text_content)).toEqual(['one','two']);
    const before=db.query('SELECT * FROM sources').all();
    await expect(sdk.knowledge.apply({reason:'invalid batch',operations:[
      {type:'update_source',args:{sourceId:'new',title:'Changed'}},
      {type:'connect_entities',args:{subject:9999,object:9998,predicate:'RELATED'}}]})).rejects.toThrow('Unknown graph entity');
    expect(db.query('SELECT * FROM sources').all()).toEqual(before);
  });

  it('rejects stale explicit versions after external writes',async()=>{
    const {db,sdk,entity,edit}=setup();const node=entity('Node');
    const version=recordVersion(db,'entity',node.id);
    sdk.graph.entities.addAlias(node.id,'external-write');
    await expect(edit('update_entity',{id:node.id,name:'Wrong',expectedVersion:version})).rejects.toThrow('Stale');
    expect(sdk.graph.entities.get(node.id).name).toBe('Node');
    expect(db.query('SELECT * FROM graph_changes').all()).toHaveLength(0);
  });

  it('renames and retypes nodes, removes aliases, validates constraints, and splits assigned records',async()=>{
    const {db,sdk,edit,source,entity}=setup();const src=await source();
    const original=entity('Combined','Person'),other=entity('Org','Organization');
    sdk.graph.entities.addAlias(original.id,'Wrong alias','scope');
    await edit('remove_entity_alias',{id:original.id,name:'Wrong alias',scope:'scope'});
    expect(sdk.graph.entities.resolve('Wrong alias','scope')).toHaveLength(0);
    await edit('update_entity',{id:original.id,name:'Corrected'});
    expect(sdk.graph.entities.get(original.id).stableId).toBe(original.stableId);
    expect(sdk.graph.entities.resolve('Combined')[0]!.id).toBe(original.id);
    sdk.graph.relations.define({name:'EMPLOYED_BY',sourceTypes:['Person'],targetTypes:['Organization']});
    const connection=await edit('connect_entities',{subject:original.id,object:other.id,predicate:'EMPLOYED_BY',status:'accepted'});
    await expect(edit('update_entity',{id:original.id,type:'Location'})).rejects.toThrow('subject type');
    expect(sdk.graph.entities.get(original.id).type).toBe('Person');
    const free=entity('Free');await edit('update_entity',{id:free.id,type:'Topic'});expect(sdk.graph.entities.get(free.id).type).toBe('Topic');
    sdk.graph.entities.addAlias(original.id,'Second person');
    db.query('INSERT INTO chunk_entities VALUES(?,?)').run(src.chunkIds[0],original.id);
    const split=await edit('split_entity',{id:original.id,entities:[{ref:'second',name:'Second person',type:'Person',
      aliasesToMove:[{name:'Second person'}],claimIds:[connection.id],chunkIds:[src.chunkIds[0]]}]});
    const destination=split.entityRefs.second;
    expect(sdk.graph.claims.get(connection.id).status).toBe('superseded');
    expect(split.entities[0].claims[0].claim.subject).toBe(destination);
    expect(sdk.graph.entities.resolve('Second person')[0]!.id).toBe(destination);
    expect(db.query('SELECT * FROM chunk_entities WHERE chunk_id=? AND entity_id=?').get(src.chunkIds[0],destination)).not.toBeNull();
  });

  it('revises connections within cardinality limits, invalidates conclusions, and preserves independent edges',async()=>{
    const {db,sdk,edit,entity,claim}=setup();const a=entity('A'),b=entity('B'),c=entity('C');
    sdk.graph.relations.define({name:'ONE',maxTargets:1});
    const old=await edit('connect_entities',{subject:a.id,object:b.id,predicate:'ONE',status:'accepted',qualifiers:{reason:'old'}});
    const derived=sdk.graph.claims.add({subject:a.id,predicate:'RESULT',value:true,status:'accepted',dependsOn:[old.id]});
    const revised=await edit('revise_connection',{claimId:old.id,patch:{object:c.id,qualifiers:{reason:'new'}}});
    expect(sdk.graph.claims.get(old.id).status).toBe('superseded');expect(revised.claim.object).toBe(c.id);
    expect(sdk.graph.claims.get(derived.id).status).toBe('stale');
    expect(db.query('SELECT * FROM edges WHERE target_entity_id=? AND relation=?').get(b.id,'ONE')).toBeNull();
    const independent=await edit('connect_entities',{subject:a.id,object:c.id,predicate:'ONE',status:'accepted'});
    await edit('retract_connection',{claimId:revised.claim.id});
    expect(db.query('SELECT * FROM edges WHERE target_entity_id=? AND relation=?').get(c.id,'ONE')).not.toBeNull();
    await edit('retract_connection',{claimId:independent.id});
    expect(db.query('SELECT * FROM edges WHERE relation=?').get('ONE')).toBeNull();
    const measurement=claim(a.id,'old');
    const corrected=await edit('revise_claim',{claimId:measurement.id,patch:{value:'corrected',unit:'kg'}});
    const cleared=await edit('revise_claim',{claimId:corrected.claim.id,patch:{unit:null}});
    expect(cleared.claim.value).toBe('corrected');expect(cleared.claim.unit).toBeUndefined();
  });

  it('validates dependency cycles, reviews batches, and unlinks supersession without reactivation',async()=>{
    const {sdk,edit,entity,claim}=setup();const node=entity('Node'),a=claim(node.id,'A'),b=claim(node.id,'B'),c=claim(node.id,'C','proposed');
    await edit('add_claim_dependency',{claimId:b.id,dependsOn:a.id});
    await expect(edit('add_claim_dependency',{claimId:a.id,dependsOn:b.id})).rejects.toThrow('cycle');
    await edit('remove_claim_dependency',{claimId:b.id,dependsOn:a.id});expect(sdk.graph.claims.get(b.id).status).toBe('stale');
    await edit('batch_review_claims',{claims:[{claimId:b.id,status:'accepted'},{claimId:c.id,status:'accepted'}]});
    expect(sdk.graph.claims.get(c.id).status).toBe('accepted');
    await expect(edit('batch_review_claims',{claims:[{claimId:c.id,status:'rejected'},{claimId:'absent',status:'accepted'}]})).rejects.toThrow('Unknown claim');
    expect(sdk.graph.claims.get(c.id).status).toBe('accepted');
    sdk.graph.lifecycle.link(c.id,a.id,'supersedes','agent','correction');
    await edit('unlink_claims',{from:c.id,to:a.id,relation:'supersedes'});
    expect(sdk.graph.claims.get(a.id).status).toBe('superseded');
    expect((sdk.graph.inspect(c.id) as any).links).toHaveLength(0);
  });

  it('revises and withdraws evidence without rewriting exact historical citations',async()=>{
    const {sdk,edit,source,entity,claim}=setup();const src=await source('evidence','original evidence text');const node=entity('Fact'),fact=claim(node.id,'known');
    const original=sdk.graph.evidence.add(fact.id,{sourceId:src.sourceId,chunkIndex:1,quote:'original',locator:{start:0,end:8}});
    const revised=await edit('revise_evidence',{evidenceId:original,patch:{quote:'evidence',locator:{start:9,end:17},confidence:0.9}});
    const items=sdk.graph.evidence.list(fact.id);expect(items).toHaveLength(2);
    expect(items.find(e=>e.id===original)!.withdrawnAt).toBeDefined();expect(items.find(e=>e.id===original)!.quote).toBe('original');
    expect(sdk.graph.claims.get(fact.id).status).toBe('stale');
    const sourceOnly=await edit('revise_evidence',{evidenceId:revised.replacementId,patch:{chunkIndex:null,quote:null,locator:null,confidence:null,model:null}});
    expect(sdk.graph.evidence.list(fact.id).find(e=>e.id===sourceOnly.replacementId)!.quote).toBeUndefined();
    await edit('retract_evidence',{evidenceId:sourceOnly.replacementId});
    expect(sdk.graph.evidence.list(fact.id).every(e=>e.withdrawnAt!==undefined)).toBe(true);
    const revision=await sdk.knowledge.read('get_source_revision',{revisionId:items[0]!.revisionId}) as any;
    expect(revision.chunks[1].text_content).toBe('original evidence text');
    await expect(edit('revise_evidence',{evidenceId:original,patch:{quote:'wrong'}})).rejects.toThrow('withdrawn');
    await edit('batch_review_claims',{claims:[{claimId:fact.id,status:'accepted'}]});
    await edit('remove_source',{sourceId:src.sourceId});
    expect(sdk.graph.claims.get(fact.id).status).toBe('accepted'); // Withdrawn support no longer invalidates it.
  });

  it('keeps event and participant projections aligned after correction',async()=>{
    const {db,sdk,edit,entity}=setup();const a=entity('A','Person'),b=entity('B','Person');
    const original=sdk.graph.events.create({name:'Meeting',kind:'meeting',occurredFrom:10,occurredTo:20,status:'accepted',participants:[{entity:a.id,role:'attendee'}]});
    const updated=await edit('revise_event',{id:original.entity.id,name:'Workshop',kind:'workshop',occurredFrom:30,occurredTo:30,participants:[{entity:b.id,role:'speaker',position:1}]});
    expect(updated.entity.id).toBe(original.entity.id);expect(updated.entity.name).toBe('Workshop');expect(updated.kind).toBe('workshop');
    expect(updated.participants[0].entity).toBe(b.id);expect(updated.participants[0].position).toBe(1);
    expect(sdk.graph.claims.get(original.claimId).status).toBe('superseded');
    expect(sdk.graph.claims.get(original.participants[0]!.claimId).status).toBe('retracted');
    expect(db.query('SELECT * FROM graph_participants WHERE event_id=?').all(original.entity.id)).toHaveLength(1);
    await expect(edit('revise_event',{id:original.entity.id,occurredFrom:40,occurredTo:20})).rejects.toThrow('interval');
    expect(sdk.graph.events.get(original.entity.id).occurredFrom).toBe(30);
    const generic=await edit('revise_connection',{claimId:updated.participants[0].claimId,patch:{object:a.id,predicate:'ROLE:host',qualifiers:{position:2}}});
    expect(sdk.graph.events.get(original.entity.id).participants[0]!.entity).toBe(a.id);
    expect(sdk.graph.events.get(original.entity.id).participants[0]!.role).toBe('host');
    const kind=await edit('revise_claim',{claimId:updated.claimId,patch:{value:'conference'}});
    expect(sdk.graph.events.get(original.entity.id).claimId).toBe(kind.claim.id);
    expect(sdk.graph.events.get(original.entity.id).kind).toBe('conference');
    await edit('retract_connection',{claimId:generic.claim.id});
    expect(sdk.graph.events.get(original.entity.id).participants).toHaveLength(0);
    const version=recordVersion(db,'event',original.entity.id);
    sdk.graph.entities.rename(original.entity.id,'New event title');
    await expect(edit('revise_event',{id:original.entity.id,expectedVersion:version,kind:'old edit'})).rejects.toThrow('Stale');
  });
});

describe('Knowledge source and chunk editing',()=>{
  it('adds, revises and removes chunks with stable surviving IDs, snapshots and FTS',async()=>{
    const {db,sdk,edit,source,entity,claim}=setup();const src=await source('text','original uniquealpha');
    const node=entity('Referenced'),fact=claim(node.id,'fact');
    const sourceHash=db.query<{hash:string},[string]>('SELECT hash FROM sources WHERE id=?').get(src.sourceId)!.hash;
    const oldRevision=db.query<{id:number},[string,string]>('SELECT id FROM graph_source_revisions WHERE source_id=? AND hash=?').get(src.sourceId,sourceHash)!.id;
    const historical=sdk.graph.claims.add({subject:node.id,predicate:'PRIOR_SOURCE_TEXT',value:'original uniquealpha'});
    sdk.graph.evidence.add(historical.id,{sourceId:src.sourceId,chunkIndex:1,quote:'original uniquealpha',locator:{start:0,end:'original uniquealpha'.length}});
    const appended=await edit('add_chunk',{sourceId:src.sourceId,text:'append uniquebeta',entityIds:[node.id],claimIds:[fact.id]});
    const oldChunks=(await sdk.knowledge.read('get_source_revision',{revisionId:oldRevision}) as any).chunks;
    expect(oldChunks).toHaveLength(2);
    expect(oldChunks[1].text_content).toBe('original uniquealpha');
    await edit('revise_chunk',{sourceId:src.sourceId,chunkId:src.chunkIds[0],text:'corrected uniquegamma',chunkType:'synthetic'});
    expect(db.query('SELECT id FROM chunks WHERE id=?').get(src.chunkIds[0])).not.toBeNull();
    expect((await sdk.search.bm25({query:'uniquealpha'}))).toHaveLength(1);
    expect(db.query<{text_content:string},[string,number]>('SELECT text_content FROM chunks WHERE source_id=? AND chunk_index=?').get(src.sourceId,0)!.text_content).toBe('corrected uniquegamma');
    expect((await sdk.search.bm25({query:'uniquegamma'}))).toHaveLength(1);
    const historicalChunks=(await sdk.knowledge.read('get_source_revision',{revisionId:oldRevision}) as any).chunks;
    expect(historicalChunks.some((chunk:any)=>chunk.chunk_index===1 && chunk.text_content==='original uniquealpha')).toBe(true);
    await edit('revise_chunk',{sourceId:src.sourceId,chunkId:appended.chunkId,entityIds:[node.id],claimIds:[]});
    expect(sdk.graph.evidence.list(fact.id).every(e=>e.withdrawnAt!==undefined)).toBe(true);
    await edit('remove_chunk',{sourceId:src.sourceId,chunkId:appended.chunkId});
    expect(await sdk.search.bm25({query:'uniquebeta'})).toHaveLength(0);
    const another=await edit('add_chunk',{sourceId:src.sourceId,text:'next'});
    expect((db.query('SELECT chunk_index FROM chunks WHERE id=?').get(another.chunkId) as any).chunk_index).toBe(2);
    const listed=await sdk.knowledge.read('list_chunks',{sourceId:src.sourceId,limit:1,offset:1}) as any;
    expect(listed.total).toBe(3);expect(listed.chunks).toHaveLength(1);expect(listed.chunks[0].version).toBeGreaterThan(0);
    await expect(edit('remove_chunk',{sourceId:'wrong-source',chunkId:another.chunkId})).rejects.toThrow('Unknown live source');
  });

  it('edits source titles and URIs without changing identity or rewriting historical metadata',async()=>{
    const {db,sdk,edit,source}=setup();const src=await source('metadata');const node=sdk.graph.entities.get(src.entityId);
    const oldTitle=sdk.graph.claims.list({subject:node.id,predicate:'TITLE'})[0]!;
    const oldRevision=sdk.graph.evidence.list(oldTitle.id)[0]!;
    await edit('update_source',{sourceId:src.sourceId,title:'New title',uri:'test://new-uri',metadata:{tags:['curated']}});
    expect(sdk.graph.entities.get(node.id).stableId).toBe(node.stableId);expect(sdk.graph.entities.get(node.id).name).toBe('New title');
    expect(sdk.graph.entities.resolve('metadata')[0]!.id).toBe(node.id);expect(sdk.graph.claims.get(oldTitle.id).status).toBe('superseded');
    expect((await sdk.knowledge.read('get_source_revision',{revisionId:oldRevision.revisionId}) as any).revision.title).toBe('metadata');
    expect((await sdk.knowledge.read('inspect_source',{sourceId:src.sourceId}) as any).metadata.tags).toEqual(['curated']);
    expect((await sdk.knowledge.read('list_sources',{namespace:'knowledge'}) as any).total).toBe(1);
    expect((await sdk.knowledge.read('list_sources',{namespace:'missing'}) as any).total).toBe(0);
    await source('other');
    await expect(edit('update_source',{sourceId:src.sourceId,uri:'test://other'})).rejects.toThrow('URI already');
    expect((db.query('SELECT uri FROM sources WHERE id=?').get(src.sourceId) as any).uri).toBe('test://new-uri');
  });

  it('archives spam, blocks normalized connector identities, preserves shared nodes, and restores with remapped IDs',async()=>{
    const {db,sdk,edit,source,entity,claim}=setup();const src=await source('spam','spam uniquespam');const shared=entity('Shared'),fact=claim(shared.id,'shared');
    sdk.graph.evidence.add(fact.id,{sourceId:src.sourceId,chunkIndex:1,quote:'spam'});
    const originalCitation=sdk.graph.evidence.list(fact.id)[0]!;
    await edit('remove_source',{sourceId:src.sourceId,blockReingestion:true});
    expect(await sdk.search.bm25({query:'uniquespam'})).toHaveLength(0);
    expect(sdk.graph.entities.get(shared.id).name).toBe('Shared');expect(sdk.graph.claims.get(fact.id).status).toBe('stale');
    expect((await sdk.knowledge.read('list_sources',{status:'removed'}) as any).sources[0].id).toBe(src.sourceId);
    const archived=(await sdk.knowledge.read('list_chunks',{sourceId:src.sourceId,archived:true}) as any).chunks;
    expect(archived).toHaveLength(2);
    expect(archived[1].text_content).toContain('spam uniquespam');
    const skipped=sdk.ingest.sourceAndChunks({source:{uri:'browser-public://test%3A%2F%2Fspam',title:'spam',type:'text',origin:'browser'},chunks:[{text_content:'spam'}]});
    expect(skipped.skipped).toBe('excluded');
    await expect(edit('restore_source',{sourceId:src.sourceId})).rejects.toThrow('excluded');
    await source('occupant','other'); // Occupies a deleted numeric chunk ID.
    const restored=await edit('restore_source',{sourceId:src.sourceId,unblockReingestion:true});
    expect(restored.chunkIds[0]).not.toBe(src.chunkIds[0]);expect(sdk.graph.claims.get(fact.id).status).toBe('stale');
    expect(sdk.graph.evidence.list(fact.id)[0]!.revisionId).toBe(originalCitation.revisionId);
    const spamResults=await sdk.search.bm25({query:'uniquespam'});
    expect(spamResults).toHaveLength(2);
    expect(spamResults.every(result=>result.source_id===src.sourceId)).toBe(true);
    expect((await sdk.knowledge.read('inspect_source',{sourceId:src.sourceId}) as any).exclusions).toHaveLength(0);
  });

  it('preserves source memory snippet IDs, locators, purpose, and fingerprint across archive restore',async()=>{
    const {sdk,edit,source}=setup();
    const src=await source('memory-archive','The original source text for archival.');
    const before=sdk.memory.get(src.sourceId);
    sdk.memory.edit({sourceId:src.sourceId,expectedVersion:before.version,actor:'curator',reason:'Retain located detail',
      add:[{text:'located source detail',kind:'derived',locator:{originalChunkIndex:7,start:12,end:32,pageNumber:4},purpose:'supporting passage'}]});
    const active=sdk.memory.get(src.sourceId);
    const retained=active.snippets.find(snippet=>snippet.text==='located source detail')!;
    const fingerprint=active.freshness.fingerprint;
    await edit('remove_source',{sourceId:src.sourceId});
    const archived=JSON.parse((sdk.database.query<{snapshot:string},[string]>('SELECT snapshot FROM graph_source_archives WHERE source_id=?').get(src.sourceId)!).snapshot);
    expect(archived.memory.snippets.find((snippet:any)=>snippet.text==='located source detail')).toMatchObject({
      id:retained.id,locator:{originalChunkIndex:7,start:12,end:32,pageNumber:4},purpose:'supporting passage'});
    await edit('restore_source',{sourceId:src.sourceId});
    const restored=sdk.memory.get(src.sourceId);
    expect(restored.freshness.fingerprint).toBe(fingerprint);
    expect(restored.snippets.find(snippet=>snippet.text==='located source detail')).toMatchObject({
      id:retained.id,locator:{originalChunkIndex:7,start:12,end:32,pageNumber:4},purpose:'supporting passage'});
  });

  it('rejects restore conflicts without partial writes',async()=>{
    const {db,sdk,edit,source}=setup();const src=await source();await edit('remove_source',{sourceId:src.sourceId});
    sdk.ingest.sourceAndChunks({source:{id:'replacement',uri:'test://source',title:'replacement',type:'text',origin:'external'},chunks:[{text_content:'other'}]});
    await expect(edit('restore_source',{sourceId:src.sourceId})).rejects.toThrow('URI already');
    expect(db.query('SELECT * FROM graph_source_archives').all()).toHaveLength(1);
  });

  it('allows unblocked connector reingestion to reuse source identity and be removed again',async()=>{
    const {db,sdk,edit,source}=setup();const src=await source('returning');
    await edit('remove_source',{sourceId:src.sourceId});
    const result=sdk.ingest.sourceAndChunks({source:{uri:'test://returning',title:'returned',type:'text',origin:'external'},
      chunks:[{text_content:'returned content'}]});
    expect(result.sourceId).toBe(src.sourceId);expect(db.query('SELECT * FROM graph_source_archives').all()).toHaveLength(0);
    expect((await sdk.knowledge.read('list_sources',{status:'all'}) as any).total).toBe(1);
    await edit('remove_source',{sourceId:src.sourceId});
    const archived=(await sdk.knowledge.read('list_chunks',{sourceId:src.sourceId,archived:true}) as any).chunks;
    expect(archived).toHaveLength(2);
    expect(archived[1].text_content).toBe('returned content');
  });

  it('skips excluded Obsidian commits and browser catalog items without aborting eligible records',async()=>{
    const {db,sdk,edit}=setup();
    const noteUri='file:///vault/spam.md';
    await edit('add_source',{id:'note-spam',title:'Spam',uri:noteUri,text:'spam'});
    await edit('remove_source',{sourceId:'note-spam',blockReingestion:true});
    const checkpoint=sdk.checkpoint.save({},{key:'spam'});
    const committed=commitNote(sdk,{filePath:'/vault/spam.md',noteTitle:'Spam',noteUri,updatedAt:1,
      parsed:{title:'Spam',body:'spam',rawContent:'spam',frontmatter:{},tags:[],wikilinks:[],images:[],references:[]},chunks:[],contextualChunks:[{chunk_index:0,text_content:'spam'}]},
      {name:'Vault',path:'/vault'},'obsidian',checkpoint.id);
    expect(committed.skipped).toBe('excluded');expect(committed.edgesCreated).toBe(0);
    expect(sdk.checkpoint.getQueue()).toHaveLength(0);
    await edit('add_source',{id:'web-spam',title:'Spam',uri:'https://spam.example/',text:'spam'});
    await edit('remove_source',{sourceId:'web-spam',blockReingestion:true});
    const history=await finalizeHistoryBatch(sdk,{type:'history_batch',items:[
      {id:'spam',collectorId:'collector',url:'https://spam.example/',title:'Spam',visitTime:1},
      {id:'good',collectorId:'collector',url:'https://good.example/',title:'Good',visitTime:2},
    ]},{});
    expect(history).toEqual({ingestedCount:1,skippedCount:1});
    const bookmarks=await processBookmarksBatch(sdk,{type:'bookmarks_batch',items:[
      {id:'spam-bookmark',collectorId:'collector',url:'https://spam.example/',title:'Spam'},
      {id:'good-bookmark',collectorId:'collector',url:'https://good.example/',title:'Good'},
    ]},{});
    expect(bookmarks).toEqual({ingestedCount:1,skippedCount:1});
    expect(db.query("SELECT * FROM sources WHERE id IN ('note-spam','web-spam')").all()).toHaveLength(0);
  });
});

describe('Knowledge discovery and MCP editing',()=>{
  it('returns bounded explainable candidates and node/connection reads without writes',async()=>{
    const {db,sdk,edit,entity}=setup();const a=entity('Same'),duplicate=entity('Same'),middle=entity('Middle'),b=entity('Far');
    const edge=await edit('connect_entities',{subject:a.id,object:middle.id,predicate:'RELATES_TO',status:'accepted'});
    await edit('connect_entities',{subject:middle.id,object:b.id,predicate:'RELATES_TO',status:'accepted'});
    const changes=db.query('SELECT * FROM graph_changes').all().length;
    const duplicates=await sdk.knowledge.read('find_duplicate_entities',{entity:a.id,limit:1}) as any;
    expect(duplicates.candidates[0].into).toBe(duplicate.id);expect(duplicates.requiresReview).toBe(true);
    const links=await sdk.knowledge.read('find_connection_candidates',{entity:a.id,limit:1}) as any;
    expect(links.candidates[0].entity.id).toBe(b.id);expect(links.candidates[0].claimIds).toContain(edge.id);
    expect(links.candidates[0].signals).toContain('shared graph neighbor');
    expect((await sdk.knowledge.read('list_entities',{name:'Same',limit:1}) as any).total).toBe(2);
    expect((await sdk.knowledge.read('list_connections',{entity:middle.id,direction:'in'}) as any).connections[0].id).toBe(edge.id);
    expect(db.query('SELECT * FROM graph_changes').all()).toHaveLength(changes);
    sdk.graph.entities.merge(a.id,duplicate.id,'same identity');
    const merged=await sdk.knowledge.read('list_connections',{entity:duplicate.id,direction:'out'}) as any;
    expect(merged.connections[0].id).toBe(edge.id);expect(merged.connections[0].subjectEntity.id).toBe(duplicate.id);
  });

  it('exposes all 32 tools, validates MCP payloads, reads audits, and preserves legacy merge undo',async()=>{
    const {db,sdk}=setup();const server=createKnowledgeGraphMcpServer({sdk});
    const client=new Client({name:'editing-test',version:'1'},{capabilities:{}});
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);await client.connect(clientTransport);
    try {
      const catalog=await client.listTools();
      const expected=['list_entities','update_entity','remove_entity_alias','split_entity','append_graph','list_connections','connect_entities','revise_connection','retract_connection',
        'revise_claim','unlink_claims','add_claim_dependency','remove_claim_dependency','batch_review_claims','revise_evidence','retract_evidence','get_source_revision','revise_event',
        'find_connection_candidates','find_duplicate_entities','preview_graph_changes','apply_graph_changes','list_sources','inspect_source','add_source','update_source','remove_source',
        'restore_source','list_chunks','add_chunk','revise_chunk','remove_chunk'];
      for(const name of expected) expect(catalog.tools.some(t=>t.name===name)).toBe(true);
      expect(catalog.tools.find(t=>t.name==='remove_source')!.annotations!.destructiveHint).toBe(true);
      expect(catalog.tools.find(t=>t.name==='preview_graph_changes')!.annotations!.readOnlyHint).toBe(true);
      const call=async(name:string,args:Record<string,unknown>)=>{
        const response=await client.callTool({name,arguments:args});
        if(response.isError) throw new Error(JSON.stringify(response.content));
        return JSON.parse((response.content as any[])[0].text);
      };
      const first=await call('create_entity',{name:'A',type:'Concept'}),second=await call('create_entity',{name:'B',type:'Concept'});
      const merged=await call('merge_entities',{from:first.id,into:second.id,reason:'same identity'});
      expect(merged.auditChangeId).not.toBe(merged.changeId);
      await call('unmerge_entities',{changeId:merged.changeId});expect(sdk.graph.entities.get(first.id).canonicalId).toBeNull();
      const preview=await call('preview_graph_changes',{reason:'test new source',operations:[{type:'add_source',args:{id:'mcp-source',title:'MCP',uri:'test://mcp',text:'text'}}]});
      expect(preview.preview).toBe(true);expect(db.query('SELECT * FROM sources').all()).toHaveLength(0);
      const applied=await call('add_source',{id:'mcp-source',title:'MCP',uri:'test://mcp',text:'text',reason:'document supplied text'});
      const audit=await client.readResource({uri:`graph://changes/${applied.changeId}`});
      expect(JSON.parse((audit.contents[0] as any).text).reason).toBe('document supplied text');
      const invalid=await client.callTool({name:'connect_entities',arguments:{subject:first.id,predicate:'X',value:123,reason:'invalid connection'}});
      expect(invalid.isError).toBe(true);
      expect((invalid.structuredContent as any).error.code).toBe('VALIDATION_ERROR');
    } finally {await client.close();await server.close();}
  });
});
