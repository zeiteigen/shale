import type { PreparedSourceMemory } from './types';
import { MEMORY_LIMITS } from './types';

/** Keep agent work, then select fresh observed excerpts within the active memory budget. */
export function refineObservedMemory(current:PreparedSourceMemory, observed:PreparedSourceMemory):PreparedSourceMemory {
  const pinned=current.snippets.filter(s=>s.kind==='derived'||s.purpose!=='source coverage');
  const snippets=[...pinned];
  let characters=pinned.reduce((n,s)=>n+s.text.length,0);
  for(const candidate of observed.snippets) {
    if(snippets.some(s=>s.kind===candidate.kind&&s.text===candidate.text)) continue;
    if(snippets.length>=MEMORY_LIMITS.snippets || characters+candidate.text.length>MEMORY_LIMITS.snippetCharacters) continue;
    const prior=current.snippets.find(s=>s.kind===candidate.kind&&s.text===candidate.text);
    snippets.push(prior?{...candidate,id:prior.id}:candidate);characters+=candidate.text.length;
  }
  return {...observed,summary:current.summary,summaryMethod:current.summaryMethod,snippets};
}
