import { createHash } from 'node:crypto';
import { MEMORY_LIMITS, type MemoryChunkInput, type PreparedSnippet, type PreparedSourceMemory } from './types';
import { sourceRefreshScope } from './refresh-scope';
import { textSpan } from './text-span';
export type { PreparedSourceMemory, PreparedSnippet, MemoryLocator } from './types';

/** Fingerprint transient input, independently of the selected memory. */
export function contentFingerprint(chunks: MemoryChunkInput[]): string {
  return createHash('sha256').update(JSON.stringify(chunks.map((c, i) =>
    [c.chunk_index ?? i, c.chunk_type ?? 'verbatim', c.text_content]))).digest('hex');
}

/** Select across the whole input rather than silently retaining only its prefix. */
export function prepareSourceMemory(chunks: MemoryChunkInput[], options: { title: string; summary?: string; topic?:string; structuredObservations?:boolean }): PreparedSourceMemory {
  const seen = new Set<string>();
  let sections = chunks.map((c, i) => ({ ...c, index: c.chunk_index ?? i, text: c.text_content.trim(), base: c.text_content.length-c.text_content.trimStart().length }))
    .filter(c => c.text && !seen.has(c.text) && !!seen.add(c.text))
    .filter(c => { if(!options.structuredObservations) return true; try { return typeof JSON.parse(c.text) !== 'object'; } catch { return true; } });
  // Obsidian historically emitted a whole-note chunk AND its sections.
  // Prefer section boundaries over an overlapping whole-document copy.
  const overlapping = new Set([...sections].sort((a,b)=>b.text.length-a.text.length).slice(0,4).filter(c => {
    const contained = sections.filter(other => other !== c && other.text.length < c.text.length && c.text.includes(other.text));
    return contained.reduce((n, other) => n + other.text.length, 0) >= c.text.length * .65;
  }));
  sections = sections.filter(c=>!overlapping.has(c));
  const inputCharacters = chunks.reduce((n, c) => n + c.text_content.length, 0);
  if (!sections.length) return { summary: textSpan(options.summary || options.title,0,MEMORY_LIMITS.summary).text,
    summaryMethod: 'metadata', snippets: [], coverage: { inputCharacters, sections: 0, summarizedSections: 0, method: 'metadata' } };
  const pieces: PreparedSnippet[] = [];
  for (const section of sections) {
    // Preserve exact spans (including code/tables); no whitespace normalization of excerpts.
    for (let start = 0; start < section.text.length; start += MEMORY_LIMITS.snippet) {
      let end = Math.min(section.text.length, start + MEMORY_LIMITS.snippet);
      if (end < section.text.length) {
        const boundary = section.text.lastIndexOf('\n', end);
        if (boundary > start + 500) end = boundary;
      }
      const span=textSpan(section.text,start,end),text=span.text;
      pieces.push({ text, kind: section.chunk_type === 'synthetic' ? 'derived' : 'excerpt', purpose: 'source coverage',
        locator: { ...section.metadata, originalChunkIndex: section.index, start: span.start+section.base, end: span.end+section.base } });
      if (span.end < start + MEMORY_LIMITS.snippet) start = span.end - MEMORY_LIMITS.snippet;
    }
  }
  const chosen: PreparedSnippet[] = [];
  const uniquePieces = [...new Map(pieces.map(p=>[`${p.kind}:${p.text}`,p])).values()];
  const count = Math.min(MEMORY_LIMITS.snippets, uniquePieces.length);
  const terms=(options.topic ?? sourceRefreshScope()?.topic ?? '').toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t=>t.length>2);
  const relevant=terms.length ? uniquePieces.map((piece,index)=>({index,score:terms.reduce((n,t)=>n+(piece.text.toLocaleLowerCase().includes(t)?1:0),0)}))
    .filter(p=>p.score>0).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,8).map(p=>p.index) : [];
  const selection=[...relevant];
  for(let i=0;selection.length<count && i<uniquePieces.length;i++) {
    const index=count===1?0:Math.round(i*(uniquePieces.length-1)/(count-1));
    if(index<uniquePieces.length && !selection.includes(index)) selection.push(index);
  }
  for(let i=0;selection.length<count && i<uniquePieces.length;i++) if(!selection.includes(i)) selection.push(i);
  let remaining = MEMORY_LIMITS.snippetCharacters;
  for (let i = 0; i < count && remaining > 0; i++) {
    const piece = uniquePieces[selection[i]!]!;
    const allowance = Math.min(remaining,Math.floor(MEMORY_LIMITS.snippetCharacters/count));
    const matchedAt=relevant.includes(selection[i]!)?Math.min(...terms.map(t=>piece.text.toLocaleLowerCase().indexOf(t)).filter(n=>n>=0)):-1;
    const offset=matchedAt>=0?Math.min(Math.max(0,matchedAt-200),Math.max(0,piece.text.length-allowance)):
      i===count-1?Math.max(0,piece.text.length-allowance):0;
    const span=textSpan(piece.text,offset,offset+allowance),text=span.text;
    chosen.push({ ...piece, text, purpose:relevant.includes(selection[i]!)?'refresh relevance':'source coverage', locator: { ...piece.locator, start:(piece.locator.start as number)+span.start,
      end: (piece.locator.start as number) + span.end } });
    remaining -= text.length;
  }
  // A connector may supply the entire document as one chunk. Its middle still
  // participates in the overview; input chunk count is not a coverage measure.
  const summaryInputs=sections.flatMap(section=>section.text.split(/\n{2,}|(?=^#{1,6}\s)/gm).filter(Boolean)
    .flatMap(text=>text.length<=2000?[{...section,text,overviewHeading:undefined as string|undefined}]:Array.from({length:Math.ceil(text.length/1500)},(_,i)=>
      ({...section,overviewHeading:text.split(/(?<=[.!?])\s+|\n/)[0]!.slice(0,100),text:textSpan(text,i*1500,Math.min(text.length,(i+1)*1500)).text}))));
  const summarySections = Math.min(summaryInputs.length, 32);
  const title=textSpan(options.title,0,240).text;
  const perSection = Math.max(80, Math.floor((MEMORY_LIMITS.summaryTarget - title.length - 50) / summarySections));
  const overview: string[] = [];
  for (let i = 0; i < summarySections; i++) {
    const section = summaryInputs[summarySections === 1 ? 0 : Math.round(i * (summaryInputs.length - 1) / (summarySections - 1))]!;
    const heading = section.metadata?.closestHeading ?? section.metadata?.heading ?? section.overviewHeading;
    const sentences = section.text.replace(/^#+\s*/gm, '').split(/(?<=[.!?])\s+|\n{2,}/).filter(Boolean);
    const first = sentences[0] ?? section.text;
    const last = sentences.length > 1 ? sentences[sentences.length - 1]! : '';
    const point = `${heading ? `${heading}: ` : ''}${textSpan(first,0,Math.floor(perSection * .7)).text}${last ? ` … ${textSpan(last,0,Math.floor(perSection * .3)).text}` : ''}`;
    overview.push(point);
  }
  const generated = `Extractive overview of ${title}:\n${overview.map(p => `• ${p}`).join('\n')}`;
  const summary = options.summary ? `${textSpan(options.summary,0,MEMORY_LIMITS.summaryTarget).text}\n\nCoverage:\n${overview.map(p => `• ${p}`).join('\n')}` : generated;
  return { summary: textSpan(summary,0,MEMORY_LIMITS.summary).text, summaryMethod: 'extractive', snippets: [...new Map(chosen.map(s=>[`${s.kind}:${s.text}`,s])).values()],
    coverage: { inputCharacters, sections: summaryInputs.length, summarizedSections: summarySections, method: 'distributed-extractive' } };
}

export function memoryChunks(memory: PreparedSourceMemory): Array<MemoryChunkInput & {chunk_index:number;chunk_type:'verbatim'|'synthetic'}> {
  return [{ text_content: memory.summary, chunk_type: 'synthetic', chunk_index: 0 },
    ...memory.snippets.map((s, i) => ({ text_content: s.text, chunk_type: s.kind === 'excerpt' ? 'verbatim' as const : 'synthetic' as const,
      chunk_index: i + 1, metadata: s.locator }))];
}

export function validateMemory(memory: PreparedSourceMemory): void {
  if (!memory.summary.trim() || memory.summary.length > MEMORY_LIMITS.summary) throw new Error('Summary must contain 1–8000 characters');
  if (memory.snippets.length > MEMORY_LIMITS.snippets || memory.snippets.some(s => !s.text.trim() || s.text.length > MEMORY_LIMITS.snippet) ||
    memory.snippets.reduce((n, s) => n + s.text.length, 0) > MEMORY_LIMITS.snippetCharacters) throw new Error('Snippet budget exceeded');
  if (new Set(memory.snippets.map(s => `${s.kind}:${s.text}`)).size !== memory.snippets.length) throw new Error('Duplicate snippets');
  if(memory.snippets.some(s=>!['excerpt','derived'].includes(s.kind)||s.purpose.length>300||JSON.stringify(s.locator).length>4000||(s.id?.length??0)>256) ||
    JSON.stringify(memory.coverage).length>1000) throw new Error('Memory provenance must contain compact metadata, not source bodies');
}
