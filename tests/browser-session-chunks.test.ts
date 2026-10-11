import { expect, it } from 'bun:test';
import { sessionChunks, sessionEvidence } from '../extensions/browser/session-chunks';
import { commitSessionGraph } from '../extensions/browser/session-graph';
import { createExtensionSDK, SourceGraph } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import type { PreparedSessionData } from '../extensions/browser/types';

it('keeps a bounded narrative searchable without copying session observation JSON', () => {
 const narrative='😀'.repeat(1000), observation=JSON.stringify({visits:Array.from({length:200},(_,i)=>({url:`https://example.org/${i}`,title:'x'.repeat(500)}))});
 const chunks=sessionChunks(narrative,observation,999);
 expect(chunks.filter(c=>c.chunk_type==='synthetic').map(c=>c.text_content).join('')).toBe(narrative);
 expect(chunks.some(c=>c.chunk_type==='verbatim')).toBe(false);
 expect(chunks.every(c=>c.text_content.length<=1000)).toBe(true);
 expect(chunks.every(c=>!/\\uD800-\\uDBFF/.test('') || (!/[\\uD800-\\uDBFF]$/.test(c.text_content)&&! /^[\\uDC00-\\uDFFF]/.test(c.text_content)))).toBe(true);
 expect(chunks[0].chunk_type).toBe('synthetic');
});

it('grounds session graph relationships at source level while retaining every structured visit', () => {
 const database=createTestDatabase(),sdk=createExtensionSDK('browser',{database,namespace:'browser'});
 const prepared:PreparedSessionData={sessionId:'split',startTime:1,endTime:2,namespace:'browser',checkpointId:'split',
  visits:Array.from({length:20},(_,i)=>({url:`https://example.org/${i}`,title:`Page ${i}`,domain:'example.org',visitedAt:1+i})),
  synthesis:{sessionTitle:'Session',summary:'Summary',topics:[],dominantDomains:[],method:'heuristic'}};
 try {
  const chunks=sessionChunks('Summary',JSON.stringify(prepared.visits),500);
  sdk.ingest.sourceAndChunks({namespace:'browser',source:{id:'split',uri:'browser-session://split',title:'Session',type:'web_session',origin:'browser'},chunks});
  const graph=new SourceGraph(database,sdk.graph,'split','browser');
  expect(sessionEvidence(sdk,'split',graph).observed[0].chunkIndex).toBeUndefined();
  commitSessionGraph(sdk,'split',prepared,[],[]);
  const links=sdk.graph.claims.list({predicate:'CONTAINS_PAGE'});
  expect(links).toHaveLength(20);
  expect(links.every(c=>sdk.graph.evidence.list(c.id).some(e=>e.sourceId==='split'&&e.chunkIndex===undefined))).toBe(true);
 } finally {database.close();}
});

it('finalizes oversized sessions with bounded searchable summary and complete graph references', async () => {
 const database=createTestDatabase();
 const sdk=createExtensionSDK('browser',{database,namespace:'browser'});
 const prepared:PreparedSessionData={sessionId:'large',startTime:1,endTime:2,namespace:'browser',checkpointId:'large',
  visits:Array.from({length:79},(_,i)=>({url:`https://example.org/${i}`,title:'x'.repeat(1000)+i,domain:'example.org',visitedAt:1+i})),
  synthesis:{sessionTitle:'Large session',summary:'Preserved summary',topics:[],dominantDomains:[],method:'heuristic'}};
 try {
  const {finalizeSession}=await import('../extensions/browser/session-ingest');
  await finalizeSession(sdk,prepared,{chunkSize:1000});
  const chunks=database.query<{chunk_type:string;text_content:string},[]>('SELECT chunk_type,text_content FROM chunks ORDER BY chunk_index').all();
  expect(chunks.every(chunk=>chunk.text_content.length<=8000)).toBe(true);
  expect(chunks.every(chunk=>!chunk.text_content.includes('https://example.org/'))).toBe(true);
  expect(chunks.every(chunk=>!chunk.text_content.includes('"visits"'))).toBe(true);
  expect(sdk.graph.claims.list({predicate:'CONTAINS_PAGE'})).toHaveLength(79);
 } finally {database.close();}
});
