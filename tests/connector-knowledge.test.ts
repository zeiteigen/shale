import { afterEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtensionSDK, createMessageBus } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { prepareVault, finalizeVault } from '../extensions/obsidian/process-vaults';
import { commitNote } from '../extensions/obsidian/commit';
import { preparePageVisit, finalizePageVisit, processBookmarksBatch, processHistoryBatch } from '../extensions/browser/ingest-processor';
import { run as recoverBrowser } from '../extensions/browser/recover';
import { finalizeSession } from '../extensions/browser/session-manager';
import { commitLinksToGraph } from '../extensions/source-linker/process-links';
import { parseImageFile } from '../extensions/obsidian/parse-image';
import { commitImage } from '../extensions/obsidian/commit';
import { run as extractKnowledge } from '../extensions/knowledge-extractor';
import { executeBackup } from '../extensions/db-backup';

const databases: Database[] = [], directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) rmSync(dir,{recursive:true,force:true});
});
function fixture(namespace = 'browser') {
  const db = createTestDatabase(); databases.push(db);
  const sdk = createExtensionSDK(namespace,{database:db,namespace,messageBus:createMessageBus()});
  sdk.settings.get = ((key: string) => ({namespace,expandAtomicNotes:false,includeImages:false,
    includeMarkdown:true,enableLlmAnalysis:false} as Record<string,unknown>)[key]) as typeof sdk.settings.get;
  sdk.settings.getAll = (() => ({namespace,enableLlmAnalysis:false})) as typeof sdk.settings.getAll;
  sdk.embed = (async (texts: string | string[]) => typeof texts === 'string'
    ? [1,0,0,0] : texts.map(() => [1,0,0,0])) as typeof sdk.embed;
  return {db,sdk};
}
function vault() {
  const path = mkdtempSync(join(tmpdir(),'shale-connector-')); directories.push(path);
  return {id:path,name:'Same vault name',path};
}

it('keeps same-titled vaults and notes distinct, preserves typed properties, and scopes wikilinks', async () => {
  const {sdk} = fixture('obsidian');
  const a = vault(), b = vault();
  for (const v of [a,b]) {
    writeFileSync(join(v.path,'Alpha.md'),'---\naliases: [First]\ntags: [science]\nactive: true\nscore: 2.5\nowner:\n  name: Alice\n---\nAlpha references [[Beta]].');
    writeFileSync(join(v.path,'Beta.md'),'Beta is a separate note.');
    const prepared = await prepareVault(v,sdk,true);
    // Resolution belongs to discovery, even if a target disappears before commit.
    rmSync(join(v.path,'Beta.md'));
    await finalizeVault(prepared,sdk);
  }
  expect(sdk.graph.entities.resolve('Alpha')).toHaveLength(2);
  expect(sdk.graph.entities.resolve('Vault: Same vault name')).toHaveLength(2);
  const notes = sdk.graph.entities.resolve('Alpha');
  expect(sdk.graph.claims.list({subject:notes[0].id,predicate:'PROPERTY:active'})[0].value).toBe(true);
  expect(sdk.graph.claims.list({subject:notes[0].id,predicate:'PROPERTY:score'})[0].value).toBe(2.5);
  expect(sdk.graph.claims.list({subject:notes[0].id,predicate:'PROPERTY:owner'})[0].value).toEqual({name:'Alice'});
  expect(sdk.graph.entities.resolve('First',`file://${a.path}`)).toHaveLength(1);
  const references = notes.map(note=>sdk.graph.claims.list({subject:note.id,predicate:'REFERENCES'})[0]);
  expect(references[0].object).not.toBe(references[1].object);
  expect(references.every(claim=>claim.status==='accepted' && claim.qualifiers?.resolved===true)).toBe(true);
  expect(sdk.graph.evidence.list(references[0].id)[0].quote).toBe('[[Beta]]');
});

it('retains ambiguous note references and refreshes chunk linkage without duplicating claims', async () => {
  const {sdk,db} = fixture('obsidian'), v = vault();
  for (const dir of ['one','two']) {
    mkdirSync(join(v.path,dir));writeFileSync(join(v.path,dir,'Beta.md'),'Separate Beta.');
  }
  writeFileSync(join(v.path,'Alpha.md'),'---\nscore: 1\n---\nSee [[Beta]].');
  const prepared = await prepareVault(v,sdk,true);
  await finalizeVault(prepared,sdk);
  const file = prepared.parsedNotes.find(note=>note.parsedFile.noteTitle==='Alpha')!.parsedFile;
  const sourceId = db.query<{id:string}, [string]>('SELECT id FROM sources WHERE uri=?').get(file.noteUri)!.id;
  const reference = sdk.graph.claims.list({predicate:'REFERENCES'})[0];
  expect(sdk.graph.entities.get(reference.object!).type).toBe('NoteReference');
  const count = sdk.graph.claims.list().length;
  commitNote(sdk,file,file.contextualChunks.map(()=>[1,0,0,0]),v);
  expect(sdk.graph.claims.list()).toHaveLength(count);
  expect(db.query('SELECT 1 FROM chunk_entities ce JOIN chunks c ON c.id=ce.chunk_id WHERE c.source_id=?').get(sourceId)).toBeTruthy();
  const oldProperty = sdk.graph.claims.list({predicate:'PROPERTY:score'})[0];
  writeFileSync(file.filePath,'---\nscore: 2\n---\nSee [[Beta]].');
  await finalizeVault(await prepareVault(v,sdk,true),sdk);
  expect(sdk.graph.claims.get(oldProperty.id).status).toBe('stale');
  expect(sdk.graph.claims.list({predicate:'PROPERTY:score',statuses:['accepted']})[0].value).toBe(2);
});

it('preserves parser image provenance and rolls back page, graph, and checkpoint changes on failure', async () => {
  const {sdk,db} = fixture();
  sdk.messages.handle('web:parse',async () => ({title:'Guide',text:'Primary page content.',chunks:['Primary page content.'],
    contextualSummary:'Generated context.',contextMethod:'llm',contextModel:'context-model',
    imageUrls:['https://example.com/a.png'],imageChunks:[{text_content:'Vision interpretation.',chunk_type:'synthetic'}],
    imageKnowledge:[{uri:'https://example.com/a.png',title:'Chart',claims:[{predicate:'VISUAL_LAYOUT',value:'Vision interpretation.',
      chunkIndex:0,status:'proposed',method:'vision',model:'vision-model'}]}],
  }),{name:'web-page-parser'});
  const prepared = (await preparePageVisit(sdk,{type:'page_visit',url:'https://example.com/guide',title:'Guide',
    textContent:'Primary content',author:'Alice',visitedAt:1000,tabId:7,recordInSession:false},{enableLlmAnalysis:false}))!;
  sdk.queryLLM = (async () => {throw new Error('Recovery must reuse analysis');}) as typeof sdk.queryLLM;
  const createEvent = sdk.graph.events.create.bind(sdk.graph.events);
  sdk.graph.events.create = () => {throw new Error('Graph storage failure');};
  await expect(finalizePageVisit(sdk,prepared,{})).rejects.toThrow('Graph storage failure');
  expect(db.query('SELECT 1 FROM sources').get()).toBeNull();
  expect(sdk.graph.claims.list()).toHaveLength(0);
  expect(sdk.checkpoint.getQueue()).toHaveLength(1);
  sdk.graph.events.create = createEvent;
  expect((await recoverBrowser(sdk)).recoveredPages).toBe(1);
  const layout = sdk.graph.claims.list({predicate:'VISUAL_LAYOUT'})[0];
  expect(layout).toMatchObject({status:'proposed',method:'vision',model:'vision-model'});
  const visualEvidence = sdk.graph.evidence.list(layout.id).find(e=>e.chunkIndex!==undefined)!;
  const revision = sdk.graph.evidence.revision(visualEvidence.revisionId) as {chunks:Array<{chunk_index:number;chunk_type:string}>};
  expect(revision.chunks.find(c=>c.chunk_index===visualEvidence.chunkIndex)?.chunk_type).toBe('synthetic');
  expect(sdk.graph.events.list({kind:'page_observation'})).toHaveLength(1);
  const count = sdk.graph.claims.list().length;
  await finalizePageVisit(sdk,prepared,{});
  expect(sdk.graph.claims.list()).toHaveLength(count);
  expect(sdk.graph.events.list()).toHaveLength(1);
});

it('keeps repeated session page visits as ordered events, with observed logs and proposed summaries', async () => {
  const {sdk,db} = fixture();
  const prepared = {sessionId:'repeat',startTime:1000,endTime:3000,namespace:'browser',checkpointId:'repeat-cp',
    synthesis:{sessionTitle:'Repeated visits',summary:'Generated summary',topics:['Databases'],dominantDomains:['example.com'],method:'llm',model:'session-model'},
    visits:[1000,2000,3000].map(visitedAt=>({url:'https://example.com/a',title:'A',domain:'example.com',visitedAt,tabId:1}))};
  await finalizeSession(sdk,prepared,{});
  const session = sdk.graph.events.list({kind:'browsing_session'})[0];
  expect(session.participants.filter(p=>p.role==='page').map(p=>p.position)).toEqual([0,1,2]);
  expect(sdk.graph.events.list({kind:'page_visit'}).map(event=>event.occurredFrom)).toEqual([1000,2000,3000]);
  expect(sdk.graph.claims.list({predicate:'SUMMARY'})[0]).toMatchObject({status:'proposed',method:'llm',model:'session-model'});
  expect(sdk.graph.claims.list({predicate:'CONTAINS_PAGE'})).toHaveLength(3);
  const count = sdk.graph.claims.list().length;
  await finalizeSession(sdk,prepared,{});
  expect(sdk.graph.events.list()).toHaveLength(4);
  expect(sdk.graph.claims.list()).toHaveLength(count);
  expect(db.query(`SELECT 1 FROM chunk_entities ce JOIN chunks c ON c.id=ce.chunk_id
    WHERE ce.entity_id=? AND c.source_id=?`).get(session.entity.id,'session:repeat')).toBeTruthy();
});

it('stores history aggregates and distinct bookmarks with evidence and folder hierarchy', async () => {
  const {sdk} = fixture();
  await processHistoryBatch(sdk,{type:'history_batch',items:[{url:'https://example.com/a',title:'A',visitTime:2000,visitCount:0,typedCount:2}]},{});
  expect(sdk.graph.claims.list({predicate:'VISIT_COUNT'})[0].value).toBe(0);
  expect(sdk.graph.claims.list({predicate:'TYPED_COUNT'})[0].value).toBe(2);
  const payload = {type:'bookmarks_batch' as const,items:['one','two'].map(id=>({id,url:'https://example.com/a',title:'A',folderPath:'Research/Databases',dateAdded:1000}))};
  await processBookmarksBatch(sdk,payload,{});
  expect(sdk.graph.entities.resolve('A').filter(entity=>entity.type==='Bookmark')).toHaveLength(2);
  expect(sdk.graph.events.list({kind:'bookmark_added'})).toHaveLength(2);
  expect(sdk.graph.claims.list({predicate:'PART_OF'})).toHaveLength(2); // Each independent bookmark is supporting evidence.
  const count = sdk.graph.claims.list().length;
  await processBookmarksBatch(sdk,payload,{});
  expect(sdk.graph.claims.list()).toHaveLength(count);
  expect(sdk.graph.entities.resolve('https://example.com/a','connector-key').filter(entity=>entity.type==='WebPage')).toHaveLength(1);
});

it('connects cross-source linker nodes to the connector records they represent', async () => {
  const {sdk,db} = fixture();
  await processHistoryBatch(sdk,{type:'history_batch',items:['a','b'].map(name=>({url:`https://example.com/${name}`,title:name,visitTime:1000}))},{});
  const sources = db.query<{id:string;title:string}, []>('SELECT id,title FROM sources ORDER BY title').all();
  commitLinksToGraph([{sourceIdA:sources[0].id,sourceIdB:sources[1].id,sourceTitleA:'a',sourceTitleB:'b',
    relation:'RELATES_TO',reason:'Related content',weight:0.8,knnSimilarity:0.9,entityResolutions:[]}],sdk);
  const bindings = sdk.graph.claims.list({predicate:'REPRESENTS'});
  expect(bindings).toHaveLength(2);
  expect(bindings.every(claim=>claim.status==='accepted' && sdk.graph.entities.get(claim.object!).type==='HistoryRecord')).toBe(true);
  expect(bindings.every(claim=>sdk.graph.evidence.list(claim.id).length===1)).toBe(true);
});

it('keeps a domain and a bookmark folder with the same label as separate identities', async () => {
  const {sdk} = fixture();
  await processBookmarksBatch(sdk,{type:'bookmarks_batch',items:[{id:'one',url:'https://example.com/a',
    title:'A',folderPath:'example.com',dateAdded:1000}]},{});
  const entities = sdk.graph.entities.resolve('example.com');
  expect(entities.map(entity=>entity.type).sort()).toEqual(['BookmarkFolder','Domain']);
  const domain = sdk.graph.claims.list({predicate:'BELONGS_TO_DOMAIN'})[0];
  const folder = sdk.graph.claims.list({predicate:'BOOKMARKED_IN'})[0];
  expect(domain.object).not.toBe(folder.object);
});

it('invalidates image interpretations on binary changes and excludes vision text from factual extraction', async () => {
  const {sdk} = fixture('obsidian'), v = vault();
  const path = join(v.path,'diagram.png');writeFileSync(path,'first image bytes');
  sdk.queryLLM = (async () => '1. Physical layout and visual elements: Two boxes.\n2. Underlying meaning: A data pipeline.') as unknown as typeof sdk.queryLLM;
  const first = await parseImageFile(path,sdk);
  const original = commitImage(sdk,first,first.contextualChunks.map(()=>[1,0,0,0]),v);
  const layout = sdk.graph.claims.list({predicate:'VISUAL_LAYOUT'})[0];
  writeFileSync(path,'different image bytes');
  const second = await parseImageFile(path,sdk);
  expect(second.assetHash).not.toBe(first.assetHash);
  const refreshed = commitImage(sdk,second,second.contextualChunks.map(()=>[1,0,0,0]),v);
  expect(refreshed.sourceId).toBe(original.sourceId);
  expect(sdk.graph.claims.get(layout.id).status).toBe('stale');
  const extractor = createExtensionSDK('knowledge-extractor',{database:sdk.database,namespace:'knowledge'});
  extractor.queryLLM = (async () => {throw new Error('Generated vision text must not be re-extracted as primary evidence');}) as typeof extractor.queryLLM;
  expect((await extractKnowledge(extractor)).committed).toBe(1);
  expect(extractor.graph.claims.list({namespace:'knowledge'})).toHaveLength(0);
});

it('scopes coreference candidates to source pairs instead of merging equal person names', () => {
  const {sdk} = fixture();
  for (const pair of [['a','b'],['c','d']]) commitLinksToGraph([{
    sourceIdA:pair[0],sourceIdB:pair[1],sourceTitleA:pair[0],sourceTitleB:pair[1],
    relation:'RELATES_TO',reason:'Compared sources',weight:0.9,knnSimilarity:0.9,
    entityResolutions:[{canonicalName:'Alice',entityType:'Person',mentionsA:['Alice'],mentionsB:['A.'],
      confidence:0.8,reason:'Possible alias in these sources'}],
  }],sdk);
  const candidates = sdk.graph.entities.resolve('Alice');
  expect(candidates).toHaveLength(2);
  expect(candidates.every(entity=>entity.canonicalId===null)).toBe(true);
  expect(sdk.graph.entities.resolve('A.','source:b')).toHaveLength(1);
  expect(sdk.graph.entities.resolve('A.','source:d')[0].id).not.toBe(sdk.graph.entities.resolve('A.','source:b')[0].id);
  expect(sdk.graph.claims.list({predicate:'COREFERS_TO'}).every(claim=>claim.status==='proposed')).toBe(true);
});

it('attaches grounded extraction proposals to the connector-owned document identity', async () => {
  const {sdk,db} = fixture('obsidian'), v = vault();
  writeFileSync(join(v.path,'Alpha.md'),'Alice recommends SQLite.');
  await finalizeVault(await prepareVault(v,sdk,true),sdk);
  const extractor = createExtensionSDK('knowledge-extractor',{database:db,namespace:'knowledge'});
  extractor.queryLLM = (async () => JSON.stringify({entities:[{key:'alice',name:'Alice',type:'Person'},
    {key:'sqlite',name:'SQLite',type:'Product'}],claims:[{subject:'alice',predicate:'RECOMMENDS',object:'sqlite',
      evidence:[{chunkIndex:0,quote:'Alice recommends SQLite.'}]}],events:[]})) as unknown as typeof extractor.queryLLM;
  expect((await extractKnowledge(extractor)).committed).toBe(1);
  const note = sdk.graph.entities.resolve('Alpha')[0];
  const mentions = extractor.graph.claims.list({subject:note.id,predicate:'MENTIONS_ENTITY'});
  expect(mentions).toHaveLength(2);
  expect(mentions.every(claim=>claim.status==='proposed' && extractor.graph.evidence.list(claim.id)[0].quote==='Alice recommends SQLite.')).toBe(true);
});

it('backs up connector claims, evidence, revisions, events, and identity aliases together', async () => {
  const {sdk,db} = fixture(), v = vault();
  await processBookmarksBatch(sdk,{type:'bookmarks_batch',items:[{id:'one',url:'https://example.com/a',
    title:'A',folderPath:'Research',dateAdded:1000}]},{});
  const result = await executeBackup(sdk,{backupDir:join(v.path,'backups'),maxBackups:2,filenamePrefix:'connector-'});
  expect(result.success).toBe(true);
  const snapshot = new Database(result.backupPath!,{readonly:true});
  try {
    sqliteVec.load(snapshot);
    expect(snapshot.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});
    expect(snapshot.query('PRAGMA foreign_key_check').all()).toEqual([]);
    for (const table of ['graph_claims','graph_evidence','graph_source_revisions','graph_revision_chunks','graph_events','graph_participants','graph_aliases']) {
      const count = db.query(`SELECT count(*) AS n FROM ${table}`).get();
      expect(snapshot.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual(count);
    }
  } finally { snapshot.close(); }
});
