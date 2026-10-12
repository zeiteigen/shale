import { useState } from 'react';
import { ArrowUpRight, CircleDot, Network, X } from 'lucide-react';
import { ClaimPanel } from './ClaimPanel';
import { ConnectionPanel, type NodeConnection } from './ConnectionPanel';
import { IdentityPanel } from './IdentityPanel';
import { SensitivityControl } from './SensitivityControl';
import { MemoryOverview, SnippetPanel } from './SourceMemoryPanel';
import { useSourceMemory } from './use-source-memory';
import type { GraphNode } from './types';
import './node-reader.css';

const tabs = ['Overview', 'Snippets', 'Connections', 'Claims', 'Details'] as const;
type ReaderTab = typeof tabs[number];

export function NodeReader({ node, nodes, connections, onSelect, onClose, onChanged, onFocus, context, at }: {
  node: GraphNode; nodes: GraphNode[]; connections: NodeConnection[]; onSelect: (node: GraphNode) => void;
  onClose: () => void; onChanged: () => void; onFocus: () => void; context?: string; at?: number;
}) {
  const [tab, setTab] = useState<ReaderTab>('Overview');
  const { memory, error, loading } = useSourceMemory(node);
  const neighbors = new Set(connections.map(connection => connection.node.id)).size;
  function changeTab(next: ReaderTab) { setTab(next); }
  return <>
    <header className="reader-header">
      <button className="close-reading" onClick={onClose} aria-label="Close reading pane"><X size={17} /></button>
      <p className="eyebrow"><CircleDot size={14} />{node.type}<span className="reader-origin">{node.namespace}</span></p>
      <h2>{node.name}</h2>
      <div className="reader-meta"><span>{neighbors} connected {neighbors === 1 ? 'entry' : 'entries'}</span>{memory && <span>{memory.snippets.length} snippets</span>}</div>
      <div className="reader-actions">{node.sourceUri && <a className="source-link" href={node.sourceUri} target="_blank" rel="noreferrer">Open source <ArrowUpRight size={14} /></a>}<button className="reader-focus" onClick={onFocus}><Network size={14} />Focus on map</button></div>
    </header>
    <div className="reader-tabs" role="tablist" aria-label="Entry details">{tabs.map((item, index) => <button key={item} id={`reader-tab-${item}`} role="tab" aria-selected={tab === item} aria-controls={`reader-panel-${node.id}`} tabIndex={tab === item ? 0 : -1} onClick={() => changeTab(item)} onKeyDown={event => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : step ? tabs[(index + step + tabs.length) % tabs.length] : undefined;
      if (next) { event.preventDefault(); changeTab(next); document.getElementById(`reader-tab-${next}`)?.focus(); }
    }}>{item}</button>)}</div>
    <div className="reader-body" role="tabpanel" id={`reader-panel-${node.id}`} aria-labelledby={`reader-tab-${tab}`} tabIndex={0}>
      {(tab === 'Overview' || tab === 'Snippets') && loading && <p className="quiet" role="status">Loading retained memory…</p>}
      {(tab === 'Overview' || tab === 'Snippets') && error && <p className="error-note" role="alert">Unable to load source memory: {error}</p>}
      {tab === 'Overview' && <>
        {memory ? <MemoryOverview key={memory.version} memory={memory} /> : !loading && !error && <section className="entity-overview"><h3>About this entry</h3><p>This {node.type.toLowerCase()} connects {neighbors} {neighbors === 1 ? 'entry' : 'entries'} in the collection. Explore its relationships or inspect claims and their evidence.</p></section>}
        <ConnectionPanel node={node} connections={connections} onSelect={onSelect} preview onShowAll={() => changeTab('Connections')} />
        <button className="reader-more" onClick={() => changeTab('Claims')}>Inspect claims and evidence <ArrowUpRight size={14} /></button>
      </>}
      {tab === 'Snippets' && (memory ? <SnippetPanel memory={memory} /> : !loading && !error && <p className="quiet">No source memory is attached to this entry. Its connections lead to related sources.</p>)}
      {tab === 'Connections' && <ConnectionPanel node={node} connections={connections} onSelect={onSelect} />}
      {tab === 'Claims' && <ClaimPanel node={node} nodes={nodes} onChanged={onChanged} context={context} at={at} />}
      {tab === 'Details' && <>
        <div className="reader-section-heading"><h3>Source and identity</h3></div>
        <dl className="reader-properties"><dt>Type</dt><dd>{node.type}</dd><dt>Origin</dt><dd>{node.namespace}</dd><dt>Stable identity</dt><dd>{node.stableId}</dd>{node.sourceUri && <><dt>Source</dt><dd><a href={node.sourceUri} target="_blank" rel="noreferrer">{node.sourceUri}</a></dd></>}{memory && <><dt>Memory version</dt><dd>{memory.version}</dd><dt>Retention</dt><dd>Summary and snippets</dd></>}</dl>
        <SensitivityControl kind="entity" id={node.id} label="Entry" />
        {(memory?.source.id ?? node.sourceId) && <SensitivityControl kind="source" id={memory?.source.id ?? node.sourceId!} label="Source" />}
        <IdentityPanel node={node} nodes={nodes} onChanged={onChanged} />
      </>}
    </div>
  </>;
}
