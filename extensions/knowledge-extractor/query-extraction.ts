import type { ShaleSDK } from '@shale/sdk';
import type { ExtractionCheckpoint } from './types';
import { parseExtraction } from './parse';
import { groundEvidence } from './evidence';
import { validateTemporalEvidence } from './temporal-evidence';
import { TruncatedChatCompletionError } from '../../lib/ai/chat-errors';

export class InvalidExtractionError extends Error {}

type ParseContext = Parameters<typeof parseExtraction>[1];
const TIME_FIELDS = ['validFrom','validTo','observedAt','occurredFrom','occurredTo'] as const;

/**
 * Keep what is valid from a response that failed validation as a whole: drop individual claims or events
 * that cannot be grounded, and timestamps not stated in their quotes. Nothing unsupported is kept; the
 * window's summary and entities survive one bad claim. Returns null when nothing usable remains.
 */
export function salvageExtraction(raw: string, context: Omit<ExtractionCheckpoint, 'extraction'>, parseContext: ParseContext) {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const list = (key: string) => Array.isArray(parsed[key]) ? (parsed[key] as Array<Record<string, unknown>>).slice(0, 100) : [];
  const seen = new Set<string>();
  const entities = list('entities').filter(entity => {
    try { parseExtraction(JSON.stringify({ entities: [entity], claims: [], events: [] })); }
    catch { return false; }
    if (seen.has(entity.key as string)) return false;
    seen.add(entity.key as string);
    return true;
  });
  const base = { ...parsed, entities, claims: [], events: [] };
  const valid = (kind: 'claims' | 'events', item: Record<string, unknown>) => {
    const candidate = { ...item };
    if (kind === 'claims' && candidate.object !== undefined && candidate.value !== undefined) {
      if (seen.has(candidate.object as string)) delete candidate.value; else delete candidate.object;
    }
    try {
      const single = parseExtraction(JSON.stringify({ ...base, [kind]: [candidate] }), parseContext);
      const data = { ...context, extraction: single } as ExtractionCheckpoint;
      for (const entry of [...single.claims, ...single.events]) groundEvidence(data, entry.evidence);
      try { validateTemporalEvidence(data); } catch { for (const field of TIME_FIELDS) delete candidate[field]; }
      return candidate;
    } catch { return null; }
  };
  const claims = list('claims').map(claim => valid('claims', claim)).filter(Boolean);
  const events = list('events').map(event => valid('events', event)).filter(Boolean);
  try {
    const extraction = parseExtraction(JSON.stringify({ ...base, claims, events }), parseContext);
    const data = { ...context, extraction } as ExtractionCheckpoint;
    validateTemporalEvidence(data);
    if (!extraction.entities.length && !extraction.claims.length && !extraction.events.length && !extraction.summary) return null;
    return data;
  } catch { return null; }
}

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
      const digest = context.digest;
      const data = {...context, extraction:parseExtraction(raw, digest ? {registryIds:new Set(digest.registry.map(entry=>entry.id)),
        episodeIds:new Set(digest.episodes.map(entry=>entry.id)),text:context.chunks.map(chunk=>chunk.text_content).join('\n'),
        sourceUri:digest.sourceUri} : {})};
      for (const claim of data.extraction.claims) groundEvidence(data,claim.evidence);
      for (const event of data.extraction.events) groundEvidence(data,event.evidence);
      validateTemporalEvidence(data);
      sdk.state.delete(rejectedKey);
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sdk.state.set(rejectedKey, JSON.stringify({raw,error:message,model:context.model,at:Date.now()}));
      if (attempt === 2) {
        const digest = context.digest;
        const salvaged = salvageExtraction(raw, context, digest ? {registryIds:new Set(digest.registry.map(entry=>entry.id)),
          episodeIds:new Set(digest.episodes.map(entry=>entry.id)),text:context.chunks.map(chunk=>chunk.text_content).join('\n'),
          sourceUri:digest.sourceUri} : {});
        if (salvaged) {
          sdk.logger.warn(`Knowledge extraction for revision ${context.revisionId} kept its valid parts after: ${message}`);
          return salvaged;
        }
        throw new InvalidExtractionError(`Invalid knowledge extraction for revision ${context.revisionId}: ${message}`, {cause:error});
      }
      previous = raw;
      feedback = `Your previous output failed validation: ${message}. Return the complete corrected JSON extraction. Preserve valid facts. Every subject/object must name a declared entity key; use value for text literals. Omit unused optional fields, including object or value; never include both. Copy evidence exactly without correcting or reformatting source text. Use shorter exact quotes. Remove assertions that cannot be supported by the supplied chunks. Do not invent facts to satisfy the schema.`;
    }
  }
  throw new Error('Knowledge extraction attempts exhausted');
}
