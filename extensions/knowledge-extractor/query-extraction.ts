import type { ShaleSDK } from '@shale/sdk';
import type { ExtractionCheckpoint } from './types';
import { parseExtraction } from './parse';
import { groundEvidence } from './evidence';
import { validateTemporalEvidence } from './temporal-evidence';
import { TruncatedChatCompletionError } from '../../lib/ai/chat-errors';

export class InvalidExtractionError extends Error {}

/** Retry invalid structured output with feedback; never checkpoint unsupported claims. */
export async function queryExtraction(sdk: ShaleSDK, prompt: string,
  context: Omit<ExtractionCheckpoint, 'extraction'>): Promise<ExtractionCheckpoint> {
  const rejectedKey = `extraction-rejected:${context.revisionId}`;
  let feedback = '';
  let previous: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const input = previous === undefined ? prompt : {messages:[
      {role:'user' as const,content:prompt},
      {role:'assistant' as const,content:previous},
      {role:'user' as const,content:feedback},
    ]};
    let raw: string;
    try {
      raw = await sdk.queryLLM(input, {
        model:context.model,responseFormat:{type:'json_object'},temperature:0.1,
        reasoningEffort:'none',maxThinkingTokens:null,maxTokens:8192,
      });
    } catch (error) {
      if (!(error instanceof TruncatedChatCompletionError)) throw error;
      sdk.state.set(rejectedKey, JSON.stringify({raw:error.content,error:error.message,model:context.model,at:Date.now()}));
      throw new InvalidExtractionError(`Invalid knowledge extraction for revision ${context.revisionId}: ${error.message}`, {cause:error});
    }
    try {
      const data = {...context, extraction:parseExtraction(raw)};
      for (const claim of data.extraction.claims) groundEvidence(data,claim.evidence);
      for (const event of data.extraction.events) groundEvidence(data,event.evidence);
      validateTemporalEvidence(data);
      sdk.state.delete(rejectedKey);
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sdk.state.set(rejectedKey, JSON.stringify({raw,error:message,model:context.model,at:Date.now()}));
      if (attempt === 2) throw new InvalidExtractionError(`Invalid knowledge extraction for revision ${context.revisionId}: ${message}`, {cause:error});
      previous = raw;
      feedback = `Your previous output failed validation: ${message}. Return the complete corrected JSON extraction. Preserve valid facts. Every subject/object must name a declared entity key; use value for text literals. Omit unused optional fields, including object or value; never include both. Copy evidence exactly without correcting or reformatting source text. Use shorter exact quotes. Remove assertions that cannot be supported by the supplied chunks. Do not invent facts to satisfy the schema.`;
    }
  }
  throw new Error('Knowledge extraction attempts exhausted');
}
