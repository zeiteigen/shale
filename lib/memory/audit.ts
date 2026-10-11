import { createHash } from 'node:crypto';

/** Audit corrections using record/version references, not an additional content archive. */
export function compactAudit(value:unknown,key=''):unknown {
  if (typeof value==='string' && (['text','text_content','rawContent','body','combinedText'].includes(key) || value.length>1200))
    return {characters:value.length,fingerprint:createHash('sha256').update(value).digest('hex'),retained:false};
  if(Array.isArray(value)) return value.map(item=>compactAudit(item,key));
  if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,compactAudit(v,k)]));
  return value;
}
