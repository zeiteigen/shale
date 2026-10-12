import { useState } from 'react';
import { Search } from 'lucide-react';
import { ReadableText } from './ReadableText';
import type { SourceMemory } from './types';

const summaryLabels: Record<string, string> = { model: 'Model summary', extractive: 'Extractive overview', metadata: 'Metadata only', agent: 'Refined summary' };

export function MemoryOverview({ memory }: { memory: SourceMemory }) {
  const [expanded, setExpanded] = useState(false);
  return <section className="memory-overview">
    <div className="reader-section-heading"><h3>Summary</h3><span className="memory-method">{summaryLabels[memory.summary.method] ?? 'Summary'}</span></div>
    <div className={`memory-summary${expanded || memory.summary.text.length <= 800 ? ' expanded' : ''}`}><ReadableText text={memory.summary.text} extractive={memory.summary.method === 'extractive'} /></div>
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
    {snippets.map(snippet => <SnippetCard key={snippet.id} snippet={snippet} number={memory.snippets.findIndex(item => item.id === snippet.id) + 1} />)}
    {!snippets.length && <p className="quiet">{query ? 'No snippets match your filter.' : 'No retained snippets for this source.'}</p>}
  </section>;
}

function SnippetCard({ snippet, number }: { snippet: SourceMemory['snippets'][number]; number: number }) {
  const [open, setOpen] = useState(false);
  return <details className="snippet-card" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span className="snippet-heading"><span className={`snippet-kind ${snippet.kind}`}>{snippet.kind === 'excerpt' ? 'Quoted excerpt' : 'Derived note'}</span><span className="snippet-number">{String(number).padStart(2, '0')}</span></span><span className="snippet-preview">{snippet.text.replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim()}</span></summary>
    {open && <div className="snippet-body"><ReadableText text={snippet.text} /><div className="snippet-provenance">{snippetLocation(snippet.locator) && <span>{snippetLocation(snippet.locator)}</span>}{snippet.purpose && <span>{snippet.purpose}</span>}</div></div>}
  </details>;
}
