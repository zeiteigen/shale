import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from './fixtures/database';
import { holdDatabaseWriter } from './fixtures/held-writer';
import { configureDatabaseConnection } from '../lib/database-connection';
import { createExtensionSDK } from '../sdk';
import { commitExtractions } from '../extensions/knowledge-extractor/commit';

it('commits saved extraction after another process releases the writer', async () => {
  const directory=mkdtempSync(join(tmpdir(),'shale-extraction-writer-')), path=join(directory,'graph.db');
  const db=createTestDatabase(path); configureDatabaseConnection(db);
  const sdk=createExtensionSDK('knowledge-extractor',{database:db});
  let writer: Awaited<ReturnType<typeof holdDatabaseWriter>> | undefined;
  try {
    sdk.ingest.sourceAndChunks({source:{id:'source',uri:'test://source',title:'Guide',origin:'test',type:'note'},
      chunks:[{text_content:'SQLite is a database.'}]});
    const revision=db.query<{id:number},[]>("SELECT id FROM graph_source_revisions WHERE source_id='source'").get()!;
    sdk.checkpoint.save({type:'knowledge-extraction',sourceId:'source',revisionId:revision.id,namespace:'knowledge',
      chunks:[{chunk_index:0,text_content:'SQLite is a database.'}],
      extraction:{entities:[],claims:[],events:[],summary:'SQLite is a database.'}},
      {id:`knowledge-extraction:${revision.id}:0:0`});
    writer=await holdDatabaseWriter(path);
    expect(commitExtractions(sdk)).toBe(1);
    expect(await writer.exited).toBe(0);
    expect(sdk.state.get(`extracted:${revision.id}`)).toBe('complete');
    expect(sdk.hasCheckpoints()).toBe(false);
  } finally {await writer?.close();db.close();rmSync(directory,{recursive:true,force:true});}
});
