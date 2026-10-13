import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from './fixtures/database';
import { holdDatabaseWriter } from './fixtures/held-writer';
import { configureDatabaseConnection } from '../lib/database-connection';
import { createExtensionSDK } from '../sdk';
import { classifySources } from '../lib/access/source-classify';
import { classifyRevisions } from '../lib/access/revision-classify';

it('classifies truncated sources and their revisions while another process writes', async () => {
  const directory=mkdtempSync(join(tmpdir(),'shale-classifier-writer-')),path=join(directory,'graph.db');
  const db=createTestDatabase(path);configureDatabaseConnection(db);
  const sdk=createExtensionSDK('classification-concurrency',{database:db});
  let writer:Awaited<ReturnType<typeof holdDatabaseWriter>>|undefined;
  try {
    for(let i=0;i<2;i++) sdk.ingest.sourceAndChunks({source:{id:`source-${i}`,uri:`test://source-${i}`,title:'Guide',origin:'test',type:'note'},
      chunks:[{text_content:'A'.repeat(200_001)},{text_content:'More source content.'}]});
    writer=await holdDatabaseWriter(path);
    expect(classifySources(db,Infinity,2)).toEqual({classified:2,pending:false});
    expect(await writer.exited).toBe(0);
    await writer.close();
    writer=await holdDatabaseWriter(path);
    expect(classifyRevisions(db,Infinity,2)).toEqual({classified:2,pending:false});
    expect(await writer.exited).toBe(0);
  } finally {await writer?.close();db.close();rmSync(directory,{recursive:true,force:true});}
});
