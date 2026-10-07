import { expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unfinishedFiles, recordCommittedFile } from '../extensions/obsidian/file-progress';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';

it('recognizes both historical raw file URIs and encoded URIs without repeating notes or images', () => {
 const directory=mkdtempSync(join(tmpdir(),'shale-file-progress-')), database=createTestDatabase();
 const sdk=createExtensionSDK('obsidian parser',{database});
 try {
  const raw=join(directory,'A note #100%.md'),encoded=join(directory,'Pasted image #100%.png');
  for(const path of [raw,encoded])writeFileSync(path,'source');
  recordCommittedFile(sdk,'obsidian',`file://${raw}`,Math.floor(statSync(raw).mtimeMs));
  recordCommittedFile(sdk,'obsidian',pathToFileURL(encoded).href,Math.floor(statSync(encoded).mtimeMs));
  expect(unfinishedFiles([raw,encoded],sdk,'obsidian',false)).toEqual([]);
  expect(unfinishedFiles([raw,encoded],sdk,'obsidian',true)).toEqual([raw,encoded]);
  expect(unfinishedFiles([raw,encoded],sdk,'other',false)).toEqual([raw,encoded]);
 } finally {database.close();rmSync(directory,{recursive:true,force:true});}
});
