import { describe, test, expect } from 'bun:test';
import { createTestDatabase } from './fixtures/database';
import { createExtensionSDK } from '../sdk';
import { prepareSourceMemory } from '../lib/memory/prepare';
import { withSourceRefresh } from '../lib/memory/refresh-scope';

describe('source memory',()=>{
  test('covers the end of a large source without retaining its entire body',()=>{
    const chunks=Array.from({length:80},(_,i)=>({text_content:`Section ${i}. ${`Distinct topic ${i} with substantial detail. `.repeat(50)}`,chunk_index:i}));
    const memory=prepareSourceMemory(chunks,{title:'Long manual'});
    expect(memory.summary).toContain('Section 79');
    expect(memory.snippets.at(-1)?.locator.originalChunkIndex).toBe(79);
    expect(memory.snippets.length).toBeLessThanOrEqual(16);
    expect(memory.snippets.reduce((n,s)=>n+s.text.length,0)).toBeLessThanOrEqual(12000);
    const db=createTestDatabase(),sdk=createExtensionSDK('memory',{database:db});
    const result=sdk.ingest.sourceAndChunks({source:{id:'long',title:'Long manual',uri:'test://long',origin:'test',type:'document'},chunks});
    expect(sdk.memory.get(result.sourceId).completeOriginal).toBe(false);
    expect(db.query<{size:number},[]>('SELECT sum(length(text_content)) AS size FROM chunks').get()!.size).toBeLessThanOrEqual(20000);
    expect(db.query<{type:string},[]>("SELECT type FROM sqlite_master WHERE name='graph_revision_chunks'").get()!.type).toBe('view');
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  test('includes middle sections in the overview when ingestion supplies one large chunk',()=>{
    const text=Array.from({length:8},(_,i)=>`${i===4?'Rare calibration conclusion.':`Chapter ${i} findings.`} ${'Supporting detail. '.repeat(50)}`).join('\n\n');
    const memory=prepareSourceMemory([{text_content:text}],{title:'Single-chunk document'});
    expect(memory.summary).toContain('Rare calibration conclusion');
    expect(memory.summary).toContain('Chapter 7 findings');
    expect(memory.coverage.sections).toBe(8);
  });

  test('keeps login captures available explicitly without promoting them in default knowledge search',()=>{
    const db=createTestDatabase(),sdk=createExtensionSDK('memory',{database:db});
    for(const [id,type,quality] of [['login','web_page','metadata'],['article','web_page','full'],['note','note',undefined]] as const)
      sdk.ingest.sourceAndChunks({source:{id,title:`Calibration ${id}`,type,uri:`test://${id}`,origin:'test',observation:{quality}},chunks:[{text_content:`Calibration ${id} details.`}]});
    expect(sdk.memory.search({query:'calibration'}).hits.map(s=>s.sourceId).sort()).toEqual(['article','note']);
    expect(sdk.memory.search({query:'calibration',sourceId:'login'}).hits[0]!.observation.quality).toBe('metadata');
    expect(sdk.memory.search({query:'calibration',type:'web_page'}).totalSources).toBe(2);
    db.close();
  });

  test('agent refinement is optimistic, replayable, and preserved by passive recapture',()=>{
    const db=createTestDatabase(),sdk=createExtensionSDK('memory',{database:db});
    const input={source:{id:'s',title:'Guide',uri:'test://s',origin:'test',type:'note'},chunks:[{text_content:'Polar coordinates describe position with a radius and angle.'}]};
    sdk.ingest.sourceAndChunks(input);
    const before=sdk.memory.get('s');
    const edit={sourceId:'s',expectedVersion:before.version,actor:'agent',reason:'Clarify meaning',requestId:'r1',
      summary:'This guide introduces radius and angle.',add:[{text:'Use polar coordinates for radial symmetry.',kind:'derived' as const,locator:{},purpose:'application'}]};
    const receipt=sdk.memory.edit(edit);
    expect(sdk.memory.edit(edit)).toEqual(receipt);
    expect(()=>sdk.memory.edit({...edit,requestId:'r2'})).toThrow('version conflict');
    sdk.ingest.sourceAndChunks(input);
    expect(sdk.memory.get('s').summary.text).toBe(edit.summary);
    expect(sdk.memory.get('s').snippets.some(s=>s.kind==='derived')).toBe(true);
    expect(()=>sdk.memory.edit({sourceId:'s',expectedVersion:receipt.version,actor:'agent',reason:'False quote',
      add:[{text:'This never appeared in the source',kind:'excerpt',locator:{},purpose:'invalid'}]})).toThrow('New excerpts');
    sdk.memory.edit({sourceId:'s',expectedVersion:receipt.version,actor:'agent',reason:'Select an exact smaller excerpt',
      add:[{text:'coordinates describe',kind:'excerpt',locator:{start:999,page:999},purpose:'definition'}]});
    const excerpt=sdk.memory.get('s').snippets.find(s=>s.text==='coordinates describe')!;
    expect(excerpt.locator.start).toBe(input.chunks[0]!.text_content.indexOf(excerpt.text));
    expect(excerpt.locator.page).toBeUndefined();
    db.close();
  });

  test('quoted evidence pins an immutable snippet and memory edits do not imply source changes',()=>{
    const db=createTestDatabase(),sdk=createExtensionSDK('memory',{database:db});
    const source={id:'s',title:'Guide',uri:'test://s',origin:'test',type:'note'};
    sdk.ingest.sourceAndChunks({source,chunks:[{text_content:'The radius is positive.'}]});
    const entity=sdk.graph.entities.create({name:'Radius',type:'Concept'});
    const claim=sdk.graph.claims.add({subject:entity.id,predicate:'DESCRIPTION',value:'positive',status:'accepted',method:'test',
      evidence:[{sourceId:'s',chunkIndex:1,quote:'radius is positive'}]});
    const evidence=sdk.graph.evidence.list(claim.id)[0]!;
    sdk.memory.edit({sourceId:'s',expectedVersion:1,actor:'agent',reason:'Improve synopsis',summary:'A radius describes distance.'});
    expect(sdk.graph.evidence.list(claim.id)[0]!.stale).toBe(false);
    expect(sdk.graph.claims.get(claim.id).status).toBe('accepted');
    expect(sdk.graph.evidence.revision(evidence.revisionId).chunks.length).toBeGreaterThan(0);
    sdk.ingest.sourceAndChunks({source,chunks:[{text_content:'The radius can now be signed.'}]});
    expect(sdk.graph.evidence.list(claim.id)[0]!.stale).toBe(true);
    expect(sdk.graph.claims.get(claim.id).status).toBe('stale');
    expect(JSON.stringify(sdk.graph.evidence.revision(evidence.revisionId))).toContain('The radius is positive.');
    db.close();
  });

  test('topic refresh selects omitted observed text while preserving agent work',()=>{
    const db=createTestDatabase(),sdk=createExtensionSDK('memory',{database:db});
    const input={source:{id:'manual',title:'Manual',uri:'test://manual',origin:'test',type:'document'},
      chunks:Array.from({length:80},(_,i)=>({chunk_index:i,text_content:`Chapter ${i}. ${i===33?'Rare calibration procedure. ':''}${'Additional explanatory details. '.repeat(10)}`}))};
    sdk.ingest.sourceAndChunks(input);
    expect(sdk.memory.get('manual').snippets.some(s=>s.text.includes('Rare calibration'))).toBe(false);
    sdk.memory.edit({sourceId:'manual',expectedVersion:1,actor:'agent',reason:'Improve overview',summary:'Agent synopsis.',retire:[sdk.memory.get('manual').snippets.at(-1)!.id],
      add:[{text:'A useful interpretation.',kind:'derived',purpose:'analysis',locator:{}}]});
    const fingerprint=sdk.memory.get('manual').freshness.fingerprint;
    withSourceRefresh({sourceId:'manual',uri:'test://manual',topic:'calibration'},()=>sdk.ingest.sourceAndChunks(input));
    const current=sdk.memory.get('manual');
    expect(current.freshness.fingerprint).toBe(fingerprint);
    expect(current.summary.text).toBe('Agent synopsis.');
    expect(current.snippets.some(s=>s.text.includes('Rare calibration')&&s.kind==='excerpt')).toBe(true);
    expect(current.snippets.some(s=>s.text==='A useful interpretation.')).toBe(true);
    sdk.ingest.sourceAndChunks(input);
    expect(sdk.memory.get('manual').version).toBe(current.version);
    db.close();
  });

  test('keeps UTF-16 spans exact and surviving snippet links on their original identities',()=>{
    const db=createTestDatabase(),sdk=createExtensionSDK('memory',{database:db});
    const original='a'.repeat(749)+'💫'+'b'.repeat(1200);
    const memory=prepareSourceMemory([{text_content:original}],{title:'Unicode'});
    for(const s of memory.snippets) {
      expect(original.slice(s.locator.start,s.locator.end)).toBe(s.text);
      expect(s.text.isWellFormed()).toBe(true);
    }
    sdk.ingest.sourceAndChunks({source:{id:'s',title:'Guide',uri:'test://s',origin:'test',type:'note'},
      chunks:[{text_content:'First section.'},{text_content:'Second section.'}]});
    const before=sdk.memory.get('s'),second=before.snippets[1]!;
    const chunk=db.query<{id:number},[]>("SELECT id FROM chunks WHERE source_id='s' AND chunk_index=2").get()!;
    const entity=sdk.graph.entities.create({name:'Second topic',type:'Concept'});
    db.query('INSERT INTO chunk_entities VALUES(?,?)').run(chunk.id,entity.id);
    sdk.memory.edit({sourceId:'s',expectedVersion:before.version,actor:'agent',reason:'Retire first excerpt',retire:[before.snippets[0]!.id]});
    expect(sdk.memory.get('s').snippets[0]!.id).toBe(second.id);
    expect(db.query<{id:number},[]>("SELECT id FROM chunks WHERE source_id='s' AND chunk_index=1").get()!.id).toBe(chunk.id);
    expect(db.query('SELECT 1 FROM chunk_entities WHERE chunk_id=? AND entity_id=?').get(chunk.id,entity.id)).toBeTruthy();
    db.close();
  });
});
