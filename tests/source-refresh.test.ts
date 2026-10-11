import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createExtensionSDK, createMessageBus } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { setup as setupObsidianRefresh } from '../extensions/obsidian/refresh';
import { setup as setupDirectoryRefresh } from '../extensions/directories/refresh';

const dirs:string[]=[];
const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0)) cleanup();for(const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true});});

function fixture(extension:string) {
  const dir=mkdtempSync(join(tmpdir(),`shale-${extension}-refresh-`));dirs.push(dir);
  const database=createTestDatabase(),sdk=createExtensionSDK(extension,{database,messageBus:createMessageBus(),extensionDir:dir});
  sdk.logger.log=()=>{};sdk.logger.error=()=>{};
  cleanups.push(()=>{sdk.messages.clear();database.close();});
  return {dir,database,sdk};
}

function seed(sdk:ReturnType<typeof createExtensionSDK>,id:string,path:string,origin:'obsidian'|'directories',type='text') {
  return sdk.ingest.sourceAndChunks({source:{id,type,uri:pathToFileURL(path).href,origin,title:id},chunks:[{chunk_type:'verbatim',text_content:'previous source material'}]});
}
const refresh=(sdk:ReturnType<typeof createExtensionSDK>,sourceId:string)=>(sdk.messages.request as any)('source:refresh',{sourceId});

describe('explicit source refresh',()=>{
  it('reingests an Obsidian source only while its original root is configured',async()=>{
    const {dir,sdk}=fixture('obsidian');const vault=join(dir,'vault'),file=join(vault,'note.md');mkdirSync(vault);writeFileSync(file,'# Updated note\n\nNew source material.');
    writeFileSync(join(dir,'settings.json'),JSON.stringify({customVaults:[{name:'Test Vault',path:vault}],expandAtomicNotes:false}));
    const seeded=seed(sdk,'obsidian-note',file,'obsidian','markdown_note');setupObsidianRefresh(sdk);
    expect(await refresh(sdk,seeded.sourceId)).toMatchObject({status:'refreshed'});
    expect(sdk.memory.get(seeded.sourceId).snippets.some(snippet=>snippet.text.includes('New source material'))).toBe(true);
    writeFileSync(join(dir,'settings.json'),JSON.stringify({customVaults:[],obsidianConfigPath:join(dir,'missing-config.json')}));
    expect(await refresh(sdk,seeded.sourceId)).toMatchObject({status:'unavailable'});
    expect(await refresh(sdk,'missing-source')).toMatchObject({status:'unavailable'});
  });

  it('uses the configured directories root and invokes its processor only for explicit refresh',async()=>{
    const {dir,sdk}=fixture('directories');const root=join(dir,'root'),file=join(root,'document.txt');mkdirSync(root);writeFileSync(file,'Updated document');
    writeFileSync(join(dir,'settings.json'),JSON.stringify({directories:[root],fileExtensions:['.txt']}));
    let processorCalls=0;
    sdk.messages.handle('file:can-process',async()=>({canProcess:true,supportedBy:'test-processor'}),{name:'test-processor'});
    sdk.messages.handle('file:process',async()=>{processorCalls++;return {success:true,filePath:file,fileType:'document',title:'document',uri:pathToFileURL(file).href,
      chunks:[{chunk_index:0,chunk_type:'verbatim',text_content:'Updated document from processor.'}],entities:[],edges:[],knowledge:[]};},{name:'test-processor'});
    const seeded=seed(sdk,'directory-file',file,'directories');setupDirectoryRefresh(sdk);
    expect(processorCalls).toBe(0);
    expect(await refresh(sdk,seeded.sourceId)).toMatchObject({status:'refreshed'});
    expect(processorCalls).toBe(1);
    expect(sdk.memory.get(seeded.sourceId).snippets.some(snippet=>snippet.text.includes('Updated document from processor'))).toBe(true);
    writeFileSync(join(dir,'settings.json'),JSON.stringify({directories:[]}));
    expect(await refresh(sdk,seeded.sourceId)).toMatchObject({status:'unavailable'});
    expect(await refresh(sdk,'missing-source')).toMatchObject({status:'unavailable'});
    expect(processorCalls).toBe(1);
  });
});
