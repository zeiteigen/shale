import { expect, test } from 'bun:test';
import { validateTemporalEvidence } from '../extensions/knowledge-extractor/temporal-evidence';
import type { ExtractionCheckpoint } from '../extensions/knowledge-extractor/types';

function data(quote:string, occurredFrom:number):ExtractionCheckpoint {
 return {type:'knowledge-extraction',revisionId:1,sourceId:'book',namespace:'knowledge',chunks:[],
  extraction:{entities:[],claims:[],events:[{key:'publication',name:'Publication',kind:'Publication',
   occurredFrom,participants:[],evidence:[{chunkIndex:0,quote}]}]}};
}
test('rejects the observed incorrect publication timestamp and invented day precision',()=> {
 expect(()=>validateTemporalEvidence(data('First published 2011',1289184000000))).toThrow('Unsupported extraction date');
 expect(()=>validateTemporalEvidence(data('First published 2011',Date.parse('2011-01-01')))).toThrow('Unsupported extraction date');
});
test('accepts exact quoted ISO dates and times without inferring extra precision',()=> {
 expect(()=>validateTemporalEvidence(data('Published on 2026-10-07.',Date.parse('2026-10-07')))).not.toThrow();
 expect(()=>validateTemporalEvidence(data('At 2026-10-07T12:30:00Z',Date.parse('2026-10-07T12:30:00Z')))).not.toThrow();
 expect(()=>validateTemporalEvidence(data('Published on 2026-10-07.',Date.parse('2026-10-07T12:30:00Z')))).toThrow('Unsupported extraction date');
});
