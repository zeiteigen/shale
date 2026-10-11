import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsedImageResponse } from '../extensions/obsidian/image-response';

let directory:string|undefined;
afterEach(()=>{if(directory)rmSync(directory,{recursive:true,force:true});directory=undefined;});

describe('source fingerprints',()=>{
  it('tracks original file bytes independently of model-derived image descriptions',async()=>{
    directory=mkdtempSync(join(tmpdir(),'shale-fingerprint-'));
    const path=join(directory,'diagram.png');writeFileSync(path,Buffer.from([0,1,2,3,255]));
    const response=(text:string)=>({success:true,filePath:path,fileType:'image',title:'diagram',uri:`file://${path}`,
      chunks:[{chunk_index:0,chunk_type:'synthetic',text_content:text}]}) as any;
    const first=await parsedImageResponse(response('Model description A'),path);
    const changedModel=await parsedImageResponse(response('Model description B'),path);
    expect(changedModel.sourceFingerprint).toBe(first.sourceFingerprint);
    writeFileSync(path,Buffer.from([0,1,2,3,254]));
    const changedSource=await parsedImageResponse(response('Model description B'),path);
    expect(changedSource.sourceFingerprint).not.toBe(first.sourceFingerprint);
  });
});
