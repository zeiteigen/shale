import { expect, it } from 'bun:test';
import { queryTranscription } from '../extensions/process-document/vision-transcription';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';

it('retries invalid mathematical output with Unicode notation and returns only a validated transcription', async () => {
 const database=createTestDatabase(),sdk=createExtensionSDK('process-document',{database});
 const prompts:string[]=[];
 sdk.queryLLM=(async(input:any,options:any)=>{
  prompts.push(input.system);expect(options.reasoningEffort).toBe('none');expect(options.maxThinkingTokens).toBeNull();
  return prompts.length===1 ? JSON.stringify({text:'\f = ma',blank:false}) : JSON.stringify({text:'F = ma; r̂ points outward.',blank:false});
 }) as unknown as typeof sdk.queryLLM;
 try {
  expect(await queryTranscription(sdk,'data:image/png;base64,AA==',10,'vision-test',new AbortController().signal))
   .toEqual({text:'F = ma; r̂ points outward.',blank:false});
  expect(prompts).toHaveLength(2);expect(prompts[1]).toContain('Unicode mathematical symbols');
 } finally {database.close();}
});

it('bounds malformed output retries and does not retry model transport failures', async () => {
 const database=createTestDatabase(),sdk=createExtensionSDK('process-document',{database});let calls=0;
 try {
  sdk.queryLLM=(async()=>{calls++;return 'not JSON';}) as unknown as typeof sdk.queryLLM;
  await expect(queryTranscription(sdk,'image',1,'vision-test',new AbortController().signal)).rejects.toThrow();expect(calls).toBe(3);
  calls=0;sdk.queryLLM=(async()=>{calls++;throw Error('Endpoint unavailable');}) as unknown as typeof sdk.queryLLM;
  await expect(queryTranscription(sdk,'image',1,'vision-test',new AbortController().signal)).rejects.toThrow('Endpoint unavailable');expect(calls).toBe(1);
 } finally {database.close();}
});
