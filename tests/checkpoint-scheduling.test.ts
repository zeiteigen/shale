import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from './fixtures/database';
import { createExtensionSDK } from '../sdk';
import { withChatLease } from '../sdk/chat/commit';
import { runCheckpointRecover } from '../main/index';

it('lets a lease holder finish model work while host recovery waits for its lease', async () => {
  const directory=mkdtempSync(join(tmpdir(),'shale-recovery-scheduling-'));
  const db=createTestDatabase();
  const sdk=createExtensionSDK('recovery-scheduling',{database:db,
    models:{connection:{baseUrl:'http://127.0.0.1:8080/v1',resource:'test-recovery-gpu'}}});
  const script=join(directory,'recover.ts');
  sdk.checkpoint.save({prepared:true},{id:'saved-output'});
  writeFileSync(script,`
    import {withChatLease} from ${JSON.stringify(join(import.meta.dir,'../sdk/chat/commit.ts'))};
    export async function run(sdk) {
      sdk.state.set('recovery-entered','yes');
      return withChatLease(sdk,async()=>sdk.checkpoint.resolve('saved-output'),{waitMs:500,pollMs:1});
    }
  `);
  try {
    const importer=withChatLease(sdk,async()=>{
      while (!sdk.state.get('recovery-entered')) await Bun.sleep(1);
      await sdk.models.run(async()=>{});
    });
    const recovery=runCheckpointRecover(sdk.extensionId,script,undefined,sdk);
    await Promise.all([importer,recovery]);
    expect(sdk.hasCheckpoints()).toBe(false);
    expect(sdk.state.get('chat-index-lease')).toBeNull();
  } finally {db.close();rmSync(directory,{recursive:true,force:true});}
});
