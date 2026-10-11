import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { request } from './api';
import { ClaimDetail, type ClaimInspection } from './ClaimDetail';
import { claimPredicate, claimTarget } from './claim-presentation';
import type { Claim, ClaimStatus } from '../../sdk/graph/types';
import type { GraphNode } from './types';

const pageSize = 12;
const activeStatuses: ClaimStatus[] = ['accepted', 'proposed', 'disputed', 'stale'];
const metadataPredicates = ['SOURCE_URI', 'TITLE', 'PROPERTY:*', 'CHUNK_LOCATION', 'HAS_CONTENT'];

export function ClaimPanel({ node, nodes, onChanged, context, at }: {
  node: GraphNode; nodes: GraphNode[]; onChanged: () => void; context?: string; at?: number;
}) {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [detail, setDetail] = useState<ClaimInspection | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<ClaimStatus | 'active' | 'all'>('active');
  const [includeMetadata, setIncludeMetadata] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const inspection = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setClaims([]); setDetail(null); setError(''); setLoading(true); setBusy(false);
    request<{ claims: Claim[] }>('/api/knowledge/claims', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ entityId: node.id, context, at, limit: pageSize + 1, offset,
        statuses: status === 'all' ? undefined : status === 'active' ? activeStatuses : [status],
        excludePredicates: includeMetadata ? undefined : metadataPredicates }),
    }).then(result => { if (!controller.signal.aborted) setClaims(result.claims); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); inspection.current?.abort(); };
  }, [node.id, context, at, offset, status, includeMetadata, revision]);
  async function inspect(claim: Claim) {
    inspection.current?.abort();
    const controller = new AbortController(); inspection.current = controller;
    setBusy(true); setError('');
    try {
      const result = await request<ClaimInspection>(`/api/knowledge/inspect?id=${encodeURIComponent(claim.id)}`, { signal: controller.signal });
      if (!controller.signal.aborted) setDetail(result);
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Unable to inspect claim'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  if (detail) return <ClaimDetail key={detail.claim.id} detail={detail} node={node} nodes={nodes} onBack={() => setDetail(null)} onReviewed={() => { setRevision(value => value + 1); onChanged(); }} />;
  return <section className="claims-panel">
    <div className="reader-section-heading"><h3>Claims and evidence</h3></div>
    <div className="claim-filters">
      <label>Claim status<select value={status} onChange={event => { setStatus(event.target.value as typeof status); setOffset(0); }}>
        <option value="active">Current and needs review</option><option value="all">All statuses</option>
        {(['accepted', 'proposed', 'disputed', 'stale', 'rejected', 'superseded', 'retracted'] as ClaimStatus[]).map(status => <option key={status} value={status}>{status}</option>)}
      </select></label>
      <label>Claim type<select value={includeMetadata ? 'all' : 'knowledge'} onChange={event => { setIncludeMetadata(event.target.value === 'all'); setOffset(0); }}><option value="knowledge">Knowledge claims</option><option value="all">Include source metadata</option></select></label>
    </div>
    {error && <p role="alert" className="error-note">{error}</p>}
    {loading ? <p className="quiet" role="status">Loading claims…</p> : claims.slice(0, pageSize).map(claim => <button className="claim-card" key={claim.id} disabled={busy} onClick={() => inspect(claim)}>
      <span className="claim-card-top"><span className="claim-predicate">{claimPredicate(claim)}</span><span className={`claim-status ${claim.status}`}>{claim.status}</span></span>
      <strong>{claimTarget(claim, node.id, nodes)}</strong>
      <small>{claim.object !== undefined && claim.object === node.id ? 'Incoming claim · ' : ''}Inspect evidence <ChevronRight size={12} /></small>
    </button>)}
    {!loading && !claims.length && !error && <p className="quiet">No claims match these filters.</p>}
    {!loading && (offset > 0 || claims.length > pageSize) && <div className="reader-pagination"><button disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - pageSize))}><ChevronLeft size={14} />Previous</button><span>{offset + 1}–{offset + Math.min(claims.length, pageSize)}</span><button disabled={claims.length <= pageSize} onClick={() => setOffset(value => value + pageSize)}>Next<ChevronRight size={14} /></button></div>}
  </section>;
}
