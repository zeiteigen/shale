import { expect, test } from 'bun:test';
import { createExtensionSDK, type Source } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { findKnnCandidatePairs } from '../extensions/source-linker/knn-finder';

test('candidate scans allow timers and host requests to run between synchronous vector searches', async () => {
  const database=createTestDatabase();
  const sdk=createExtensionSDK('source-linker',{database});
  const source:Source={id:'test',uri:'file:///test',title:'Test',type:'note',origin:'test',hash:'hash',created_at:1,updated_at:1};
  sdk.context.getAllSources=()=>[source];
  sdk.context.getRecentChunks=()=>Array.from({length:40},(_,id)=>({id,source_id:source.id,chunk_index:id,chunk_type:'verbatim',text_content:'text'}));
  let timerFired=false,searches=0;
  const timer=setTimeout(()=>{timerFired=true;},0);
  sdk.search.vector=async()=> {searches++;if(searches===40) expect(timerFired).toBe(true);return [];};
  try {expect(await findKnnCandidatePairs([source],sdk)).toEqual([]);expect(searches).toBe(40);}
  finally {clearTimeout(timer);database.close();}
});
