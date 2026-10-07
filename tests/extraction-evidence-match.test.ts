import { expect, test } from 'bun:test';
import { matchEvidence } from '../extensions/knowledge-extractor/evidence-match';
import { groundEvidence } from '../extensions/knowledge-extractor/evidence';
import type { ExtractionCheckpoint } from '../extensions/knowledge-extractor/types';

test('matches PDF whitespace while saving exact original text and window offsets',()=> {
 const text='prefix: Bob chose\n  SQLite.',chunks=[{chunk_index:3,text_content:text,start:100}];
 const data:ExtractionCheckpoint={type:'knowledge-extraction',revisionId:1,sourceId:'source',namespace:'test',chunks,extraction:{entities:[],claims:[],events:[]}};
 expect(groundEvidence(data,[{chunkIndex:3,quote:'Bob chose SQLite.'}])[0]).toMatchObject({
  chunkIndex:3,quote:'Bob chose\n  SQLite.',locator:{start:108,end:100+text.length}});
});
test('repairs only uniquely located chunk references and refuses ambiguous evidence',()=> {
 const chunks=[{chunk_index:4,text_content:'Alice chose SQLite.'},{chunk_index:5,text_content:'Bob chose SQLite.'}];
 expect(matchEvidence(chunks,0,'Bob chose SQLite.').chunk.chunk_index).toBe(5);
 expect(()=>matchEvidence([...chunks,{chunk_index:6,text_content:'Bob chose SQLite.'}],0,'Bob chose SQLite.')).toThrow('ambiguous');
});
test('rejects rewritten punctuation, missing words, empty quotes, and treats regex syntax literally',()=> {
 const chunks=[{chunk_index:0,text_content:"The world's economy. [a+b] = c."}];
 expect(()=>matchEvidence(chunks,0,'The world’s economy.')).toThrow('absent');
 expect(()=>matchEvidence(chunks,0,"The world's largest economy.")).toThrow('absent');
 expect(()=>matchEvidence(chunks,0,'   ')).toThrow('Empty');
 expect(matchEvidence(chunks,0,'[a+b] = c.').quote).toBe('[a+b] = c.');
});
