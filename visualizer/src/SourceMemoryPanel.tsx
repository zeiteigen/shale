import { useState } from 'react';
import { Search } from 'lucide-react';
import type { SourceMemory } from './types';

const summaryLabels: Record<string, string> = { model: 'Model summary', extractive: 'Extractive overview', metadata: 'Metadata only', agent: 'Refined summary' };

export function MemoryOverview({ memory }: { memory: SourceMemory }) {
  const [expanded, setExpanded] = useState(false);
  return <section className="memory-overview">
    <div className="reader-section-heading"><h3>Summary</h3><span className="memory-method">{summaryLabels[memory.summary.method] ?? 'Summary'}</span></div>
    <div className={`memory-summary${expanded || memory.summary.text.length <= 800 ? ' expanded' : ''}`}><p>{memory.summary.text}</p></div>
    {memory.summary.text.length > 800 && <button className="reader-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Read full summary'}</button>}
    <p className="memory-caption">{memory.snippets.length} retained snippets{memory.freshness.lastObservedAt ? ` · Observed ${new Date(memory.freshness.lastObservedAt).toLocaleDateString()}` : ''}</p>
    {memory.availability !== 'retained' && <p className="quiet">This source needs a refresh before its memory can be considered current.</p>}
  </section>;
}

function snippetLocation(locator: SourceMemory['snippets'][number]['locator']) {
  if (typeof locator.heading === 'string') return locator.heading;
  if (typeof locator.page === 'number') return `Page ${locator.page}`;
  if (typeof locator.start === 'number' && typeof locator.end === 'number') return `Characters ${locator.start}–${locator.end}`;
  return '';
}

export function SnippetPanel({ memory }: { memory: SourceMemory }) {
  const [query, setQuery] = useState('');
  const snippets = memory.snippets.filter(snippet => `${snippet.text} ${snippet.purpose}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="snippets-panel">
    <div className="reader-section-heading"><h3>Retained snippets</h3><span>{memory.snippets.length}</span></div>
    <p className="quiet">Excerpts preserve source wording. Derived notes contain interpretation.</p>
    <div className="reader-filter"><Search size={15} /><input aria-label="Filter snippets" placeholder="Find a phrase or topic" value={query} onChange={event => setQuery(event.target.value)} /></div>
    {snippets.map((snippet, index) => <details className="snippet-card" key={snippet.id}>
      <summary><span className="snippet-heading"><span className={`snippet-kind ${snippet.kind}`}>{snippet.kind === 'excerpt' ? 'Quoted excerpt' : 'Derived note'}</span><span className="snippet-number">{String(index + 1).padStart(2, '0')}</span></span><span className="snippet-preview">{snippet.text.replace(/\s+/g, ' ').trim()}</span></summary>
      <div className="snippet-body"><p>{snippet.text}</p><div className="snippet-provenance">{snippetLocation(snippet.locator) && <span>{snippetLocation(snippet.locator)}</span>}{snippet.purpose && <span>{snippet.purpose}</span>}</div></div>
    </details>)}
    {!snippets.length && <p className="quiet">{query ? 'No snippets match your filter.' : 'No retained snippets for this source.'}</p>}
  </section>;
}
