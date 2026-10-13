import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionSDK, SourceGraph } from "../sdk";
import { createTestDatabase } from "./fixtures/database";
import { prepareSourceMemory } from "../lib/memory/prepare";
import { fingerprintText } from "../lib/memory/fingerprint";
import { refineObservedMemory } from "../lib/memory/refine";
import { parseFile } from "../extensions/obsidian/parse-file";
import { commitNote } from "../extensions/obsidian/commit";
import { findDecorativeRepairs } from "../extensions/obsidian/decorative-repair";
import { applyDecorativeRepair } from "../extensions/obsidian/apply-decorative-repair";
import { run as recover } from "../extensions/obsidian/recover";
import { getGraphData } from "../visualizer/graph-data";
import { WRITE_REFERENCES } from "../lib/access/write-guard";
import { createScopedSDK, closeScopedSDKs } from "../sdk/access";
import { DEFAULT_POLICY, writeAccessPolicy, readAccessPolicy } from "../lib/access/policy";
import { findImageFiles } from "../extensions/obsidian/process-vaults";

const fixtures: Array<{dir:string;db:ReturnType<typeof createTestDatabase>}> = [];
afterEach(()=>{for(const {dir,db} of fixtures.splice(0)){db.close();rmSync(dir,{recursive:true,force:true});}});

function legacyFixture(count=3, disk=false) {
  const dir=mkdtempSync(join(tmpdir(),'shale-icon-repair-'));
  const path=join(dir,'Research.md'),uri=`file://${path}`;
  const urls=Array.from({length:count},(_,i)=>`https://t0.gstatic.com/faviconV2?type=FAVICON&url=https%3A%2F%2Fexample.com%2F${i}`);
  const raw='# Research\nUseful research on graph retrieval.\n'+urls.map((url,i)=>`[![](${url}) Citation ${i}](https://example.com/${i})`).join('\n')
    +'\n![Real diagram](chart.png)\n';
  writeFileSync(path,raw);
  const db=createTestDatabase(disk?join(dir,'graph.db'):':memory:');fixtures.push({dir,db});
  const sdk=createExtensionSDK('obsidian',{database:db,namespace:'obsidian',extensionDir:dir});
  writeFileSync(join(dir,'settings.json'),JSON.stringify({expandAtomicNotes:false}));
  sdk.ingest.sourceAndChunks({source:{id:'research',uri,title:'Research',origin:'obsidian',type:'markdown_note',hash:fingerprintText(raw)},
    chunks:[{text_content:raw}],memory:prepareSourceMemory([{text_content:raw}],{title:'Research'})});
  const graph=new SourceGraph(db,sdk.graph,'research','obsidian');
  const note=graph.entity(uri,'Research','Note');graph.claim(note,'SOURCE_URI',{value:uri});
  const icons=urls.map(url=>graph.entity(url,url,'Image'));
  const claims=icons.map((id,i)=>graph.link(note,'FEATURES_IMAGE',id,{method:'markdown',qualifiers:{target:urls[i],resolved:true}}));
  const diagram=graph.entity(`file://${dir}/chart.png`,'Chart','Image');
  const useful=graph.link(note,'FEATURES_IMAGE',diagram,{method:'markdown',qualifiers:{target:'chart.png',resolved:true}});
  return {dir,db,sdk,path,uri,raw,urls,icons,claims,note,diagram,useful};
}

it('repairs 120 legacy favicon links and memory together, preserving useful content, identities, and history', async()=>{
  const f=legacyFixture(120),before=f.sdk.memory.get('research');
  const [repair]=findDecorativeRepairs(f.sdk);
  expect(repair.claims).toHaveLength(120);
  expect(repair.generatedMemoryDirty).toBe(true);
  const receipt=await applyDecorativeRepair(f.sdk,repair);
  expect(receipt).toMatchObject({sourceId:'research',retractedClaims:120,memoryVersion:before.version+1});
  const memory=f.sdk.memory.get('research');
  expect(memory.freshness.fingerprint).toBe(before.freshness.fingerprint);
  expect(memory.source).toEqual(before.source);
  expect(memory.summary.text+memory.snippets.map(s=>s.text).join('')).not.toContain('faviconV2');
  expect(memory.snippets.some(s=>s.text.includes('Citation'))).toBe(true);
  expect(f.sdk.graph.claims.get(f.useful).status).toBe('accepted');
  expect(getGraphData(f.sdk).nodes.map(n=>n.id)).toEqual([f.note,f.diagram]);
  for(const id of f.claims) {
    expect(f.sdk.graph.claims.get(id).status).toBe('retracted');
    expect(f.sdk.graph.evidence.list(id).length).toBeGreaterThan(0);
  }
  expect(readFileSync(f.path,'utf8')).toBe(f.raw);
  expect(findDecorativeRepairs(f.sdk)).toEqual([]);
  const versions=f.sdk.memory.get('research').version;
  expect(await applyDecorativeRepair(f.sdk,repair)).toEqual(receipt);
  expect(f.sdk.memory.get('research').version).toBe(versions);
});

it('preserves manually authored summaries and snippets when rebuilding generated coverage', async()=>{
  const f=legacyFixture(),before=f.sdk.memory.get('research');
  f.sdk.memory.edit({sourceId:'research',expectedVersion:before.version,actor:'test',reason:'Reviewed memory',summary:'My reviewed overview',
    add:[{text:'An editorial interpretation',kind:'derived',purpose:'agent addition',locator:{}}]});
  await applyDecorativeRepair(f.sdk,findDecorativeRepairs(f.sdk)[0]);
  const memory=f.sdk.memory.get('research');
  expect(memory.summary.text).toBe('My reviewed overview');
  expect(memory.summary.method).toBe('agent');
  expect(memory.snippets.some(s=>s.text==='An editorial interpretation')).toBe(true);
  expect(memory.snippets.filter(s=>s.purpose==='source coverage').every(s=>!s.text.includes('faviconV2'))).toBe(true);
});

it('rolls back memory, claim states, and audit receipts when relationship retraction fails', async()=>{
  const f=legacyFixture(),before=f.sdk.memory.get('research');
  const [repair]=findDecorativeRepairs(f.sdk);
  f.db.run("CREATE TRIGGER refuse_repair BEFORE UPDATE OF status ON graph_claims WHEN NEW.status='retracted' BEGIN SELECT RAISE(ABORT,'repair failure'); END");
  await expect(applyDecorativeRepair(f.sdk,repair)).rejects.toThrow('repair failure');
  expect(f.sdk.memory.get('research')).toEqual(before);
  expect(f.claims.every(id=>f.sdk.graph.claims.get(id).status==='accepted')).toBe(true);
  expect(f.sdk.knowledge.history()).toEqual([]);
});

it('refuses stale previews and changed or missing original files without touching existing memory', async()=>{
  const f=legacyFixture(),before=f.sdk.memory.get('research');
  const [repair]=findDecorativeRepairs(f.sdk);
  f.sdk.graph.lifecycle.review(f.claims[0],'proposed','test','Concurrent edit');
  await expect(applyDecorativeRepair(f.sdk,repair)).rejects.toThrow('Stale claim');
  expect(f.sdk.memory.get('research')).toEqual(before);
  writeFileSync(f.path,f.raw+'Changed body');
  await expect(applyDecorativeRepair(f.sdk,findDecorativeRepairs(f.sdk)[0])).rejects.toThrow('original note changed');
  expect(f.sdk.memory.get('research')).toEqual(before);
  rmSync(f.path);
  await expect(applyDecorativeRepair(f.sdk,findDecorativeRepairs(f.sdk)[0])).rejects.toThrow();
});

it('fresh parsing preserves literal image examples and produces clean source memory and graph links', async()=>{
  const f=legacyFixture();
  writeFileSync(f.path,f.raw+'\n```md\n![]('+f.urls[0]+')\n```\n');
  const file=await parseFile(f.path,f.sdk,{expandAtomicNotes:false});
  expect(file.parsed.images).toEqual(['chart.png']);
  expect(file.parsed.body).toContain('```md\n![]('+f.urls[0]+')');
  expect(()=>commitNote(f.sdk,file,{name:'Research',path:f.dir})).not.toThrow();
});

it('automatic vault discovery skips local decorative assets before vision processing',()=>{
  const f=legacyFixture();
  for(const name of ['favicon.png','apple-touch-icon.png','icon-sprite.svg','chart.png','my-icon-study.png'])
    writeFileSync(join(f.dir,name),'fixture');
  expect(findImageFiles(f.dir).map(path=>path.split('/').pop()).sort()).toEqual(['chart.png','my-icon-study.png']);
});

it('does not repeatedly repair literal code whose retained overview lost its code fences',async()=>{
  const f=legacyFixture();
  const raw='An image syntax example:\n```md\n![]('+f.urls[0]+')\n```\n';
  writeFileSync(f.path,raw);
  f.sdk.ingest.sourceAndChunks({source:{id:'code',uri:`file://${f.dir}/Code.md`,title:'Code',type:'markdown_note',origin:'obsidian',hash:fingerprintText(raw)},
    chunks:[{text_content:raw}],memory:prepareSourceMemory([{text_content:raw}],{title:'Code',summary:'![]('+f.urls[0]+')'})});
  writeFileSync(join(f.dir,'Code.md'),raw);
  expect(findDecorativeRepairs(f.sdk,'code')).toEqual([]);
});

it('reprepares contaminated compact checkpoints and leaves unavailable originals pending', async()=>{
  const f=legacyFixture();
  const file=await parseFile(f.path,f.sdk,{expandAtomicNotes:false});
  file.imagePolicyVersion=undefined;
  file.parsed.images=f.urls;
  file.parsed.body='';file.parsed.rawContent='';
  delete (file as Partial<typeof file>).filePath;
  file.memory=prepareSourceMemory([{text_content:f.raw}],{title:'Research'});
  f.sdk.saveCheckpoint({type:'ai_summary',parsedFile:file,vault:{name:'Research',path:f.dir}},{id:'legacy'});
  expect(()=>commitNote(f.sdk,file,{name:'Research',path:f.dir})).toThrow('reprepare');
  expect(await recover(f.sdk)).toEqual({recoveredNotes:1,recoveredDocuments:0});
  expect(f.sdk.checkpoint.get('legacy')).toBeNull();
  expect(f.sdk.memory.get('research').snippets.every(s=>!s.text.includes('faviconV2'))).toBe(true);
  f.sdk.saveCheckpoint({type:'ai_summary',parsedFile:file,vault:{name:'Research',path:f.dir}},{id:'unavailable'});
  rmSync(f.path);
  await expect(recover(f.sdk)).rejects.toThrow('Obsidian recovery failed');
  expect(f.sdk.checkpoint.get('unavailable')).not.toBeNull();
});

it('ordinary refresh preserves generated memory while rebuild replaces only generated work',()=>{
  const current=prepareSourceMemory([{text_content:'Old generated body'}],{title:'Old'});
  const observed=prepareSourceMemory([{text_content:'Clean generated body'}],{title:'Clean'});
  expect(refineObservedMemory(current,observed).summary).toBe(current.summary);
  expect(refineObservedMemory(current,observed,'rebuild-generated').summary).toBe(observed.summary);
  expect(WRITE_REFERENCES.repair_source_memory).toEqual([['sourceId','source'],['claims[].claimId','claim']]);
});

it('the maintenance write guard refuses a source outside the caller profile',async()=>{
  const f=legacyFixture(3,true),policy=readAccessPolicy(),before=f.sdk.memory.get('research');
  try {
    writeAccessPolicy({...DEFAULT_POLICY,profiles:{...DEFAULT_POLICY.profiles,
      denied:{clearance:'secret',write:true,deny:[{uri:'*Research.md'}]}}});
    const restricted=createScopedSDK('denied',f.sdk);
    expect(findDecorativeRepairs(restricted.read)).toEqual([]);
    await expect(applyDecorativeRepair(restricted.write,findDecorativeRepairs(f.sdk)[0])).rejects.toThrow('not found or outside');
    expect(f.sdk.memory.get('research')).toEqual(before);
    expect(f.claims.every(id=>f.sdk.graph.claims.get(id).status==='accepted')).toBe(true);
  } finally {closeScopedSDKs();writeAccessPolicy(policy);}
});

it('CLI dry runs leave the database untouched and apply creates a restorable backup',async()=>{
  const f=legacyFixture(3,true),policy=readAccessPolicy(),before=f.sdk.memory.get('research');
  try {
    writeAccessPolicy(DEFAULT_POLICY);
    const run=async(args:string[])=>{
      const child=Bun.spawn(['bun','scripts/repair-decorative-images.ts',...args],{
        env:{...process.env,SHALE_DB_PATH:f.db.filename},stdout:'pipe',stderr:'pipe'});
      const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      expect({code,stderr}).toEqual({code:0,stderr:''});
      return stdout;
    };
    const preview=JSON.parse(await run(['--dry-run','--source-id','research']));
    expect(preview).toMatchObject({mode:'dry-run',sources:[{sourceId:'research',decorativeRelationships:3}]});
    expect(f.sdk.memory.get('research')).toEqual(before);
    expect(f.sdk.knowledge.history()).toEqual([]);
    const output=await run(['--apply','--source-id','research']);
    const header=JSON.parse(output.slice(0,output.lastIndexOf('\n{')));
    const backupPath=header.backup as string;
    expect(typeof backupPath).toBe('string');
    expect(header.mode).toBe('apply');
    expect(readFileSync(backupPath).byteLength).toBeGreaterThan(0);
    const backup=new Database(backupPath,{readonly:true});
    try {expect(backup.query('SELECT status FROM graph_claims WHERE id=?').get(f.claims[0])).toEqual({status:'accepted'});}
    finally {backup.close();}
    expect(findDecorativeRepairs(f.sdk)).toEqual([]);
    expect(f.sdk.graph.claims.get(f.useful).status).toBe('accepted');
  } finally {writeAccessPolicy(policy);}
});
