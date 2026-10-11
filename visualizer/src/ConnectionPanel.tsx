import { useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronRight, Search } from 'lucide-react';
import type { GraphData, GraphNode } from './types';

export interface NodeConnection { edge: GraphData['edges'][number]; node: GraphNode }

export function groupConnections(connections: NodeConnection[], selectedId: number) {
  const groups = new Map<string, { id: string; node: GraphNode; relation: string; incoming: boolean; count: number; statuses: Set<string> }>();
  for (const { edge, node } of connections) {
    const incoming = edge.target === selectedId;
    const id = JSON.stringify([node.id, edge.relation, incoming]);
    let group = groups.get(id);
    if (!group) groups.set(id, group = { id, node, relation: edge.relation, incoming, count: 0, statuses: new Set() });
    group.count++; group.statuses.add(edge.status);
  }
  return [...groups.values()].sort((a, b) => a.relation.localeCompare(b.relation) || Number(a.incoming) - Number(b.incoming) || a.node.name.localeCompare(b.node.name));
}

export function ConnectionPanel({ node, connections, onSelect, preview = false, onShowAll }: {
  node: GraphNode; connections: NodeConnection[]; onSelect: (node: GraphNode) => void;
  preview?: boolean; onShowAll?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(12);
  const groups = useMemo(() => groupConnections(connections, node.id), [connections, node.id]);
  const filtered = groups.filter(group => `${group.node.name} ${group.node.type} ${group.relation.replaceAll('_', ' ')}`.toLowerCase().includes(query.toLowerCase()));
  const visible = filtered.slice(0, preview ? 6 : limit);
  const sections = new Map<string, typeof visible>();
  for (const group of visible) {
    const key = `${group.incoming ? 'Incoming' : 'Outgoing'} · ${group.relation.replaceAll('_', ' ').toLowerCase()}`;
    const items = sections.get(key) ?? []; items.push(group); sections.set(key, items);
  }
  return <section className="connections-panel">
    <div className="reader-section-heading"><h3>{preview ? 'Connected entries' : 'Connections'}</h3><span>{groups.length}</span></div>
    {!preview && <div className="reader-filter"><Search size={15} /><input aria-label="Filter connections" placeholder="Find an entry or relationship" value={query} onChange={event => { setQuery(event.target.value); setLimit(12); }} /></div>}
    {[...sections].map(([label, items]) => <div className="connection-group" key={label}>
      <p className="connection-group-label">{label}</p>
      {items.map(group => <button key={group.id} className="connection" onClick={() => onSelect(group.node)}>
        <span className="connection-direction" title={group.incoming ? 'Incoming relationship' : 'Outgoing relationship'}>{group.incoming ? <ArrowDownLeft size={15} /> : <ArrowUpRight size={15} />}</span>
        <span className="connection-copy"><strong>{group.node.name}</strong><small>{group.node.type}{group.count > 1 ? ` · ${group.count} records` : ''}{group.statuses.size > 1 ? ' · mixed status' : group.statuses.has('accepted') ? '' : ` · ${[...group.statuses][0]}`}</small></span>
        <ChevronRight size={14} />
      </button>)}
    </div>)}
    {!visible.length && <p className="quiet">{query ? 'No connections match your filter.' : 'No graph links recorded for this entry.'}</p>}
    {preview && groups.length > 6 && <button className="reader-more" onClick={onShowAll}>View all {groups.length} connections <ChevronRight size={14} /></button>}
    {!preview && filtered.length > limit && <button className="reader-more" onClick={() => setLimit(current => current + 12)}>Show more · {filtered.length - limit} remaining</button>}
  </section>;
}
