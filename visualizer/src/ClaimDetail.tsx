import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { updateKnowledge } from './api';
import { claimPredicate, claimTarget } from './claim-presentation';
import { SensitivityControl } from './SensitivityControl';
import { ReadableText } from './ReadableText';
import type { Claim, Evidence, ClaimStatus } from '../../sdk/graph/types';
import type { GraphNode } from './types';

export interface ClaimInspection {
  claim: Claim; evidence: Evidence[]; dependencies: string[]; dependents: string[];
  reviews: Array<{ status: string; actor: string; reason: string; reviewed_at: number }>;
  history: Array<{ status: string; changed_at: number }>;
  links: Array<{ relation: string; source_id: string; target_id: string }>;
}

export function ClaimDetail({ detail, node, nodes, onBack, onReviewed }: {
  detail: ClaimInspection; node: GraphNode; nodes: GraphNode[]; onBack: () => void; onReviewed: () => void;
}) {
  const [status, setStatus] = useState<ClaimStatus>(['accepted', 'rejected', 'disputed', 'retracted'].includes(detail.claim.status) ? detail.claim.status : 'accepted');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function review() {
    setBusy(true); setError('');
    try {
      await updateKnowledge('review', { id: detail.claim.id, status, reason, actor: 'user' });
      onReviewed();
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to save review'); }
    finally { setBusy(false); }
  }
  return <article className="claim-detail">
    <button className="reader-more" onClick={onBack}><ArrowLeft size={14} />Back to claims</button>
    <p className="claim-predicate">{claimPredicate(detail.claim)}</p>
    <h3>{claimTarget(detail.claim, node.id, nodes)}</h3>
    <p><span className={`claim-status ${detail.claim.status}`}>{detail.claim.status}</span> <span className="quiet">Recorded {new Date(detail.claim.recordedAt).toLocaleDateString()}</span></p>
    {(detail.claim.validFrom !== undefined || detail.claim.validTo !== undefined) && <p className="quiet">Valid {detail.claim.validFrom === undefined ? 'from an unknown date' : `from ${new Date(detail.claim.validFrom).toLocaleDateString()}`} {detail.claim.validTo === undefined ? 'onward' : `until ${new Date(detail.claim.validTo).toLocaleDateString()}`}</p>}
    <div className="reader-section-heading"><h3>Evidence</h3><span>{detail.evidence.length}</span></div>
    {detail.evidence.map(item => <blockquote key={item.id} className="evidence-card">
      {item.quote ? <ReadableText text={item.quote} /> : <p>{item.availability === 'discarded' ? 'The original passage was not retained.' : 'Evidence is attached at source level; no excerpt was saved.'}</p>}
      <cite>{item.title || 'Untitled source'}</cite>
      <div className="evidence-meta"><span>{item.stance}</span>{item.stale && <span className="evidence-stale">Source has changed</span>}{item.withdrawnAt && <span>Withdrawn</span>}{item.availability === 'discarded' && <span>Passage unavailable</span>}</div>
      {item.availability !== 'discarded' && <a href={`/api/knowledge/revision?id=${item.revisionId}`} target="_blank" rel="noreferrer">Read retained revision ↗</a>}
    </blockquote>)}
    {!detail.evidence.length && <p className="quiet">No source evidence is attached.</p>}
    <details className="reader-disclosure"><summary>Provenance and timeline</summary>
      {detail.claim.confidence !== undefined && <p>Extraction confidence: {Math.round(detail.claim.confidence * 100)}%</p>}
      {detail.claim.context && <p>Context: {detail.claim.context}</p>}
      {Object.keys(detail.claim.qualifiers ?? {}).length > 0 && <pre>{JSON.stringify(detail.claim.qualifiers, null, 2)}</pre>}
      {detail.dependencies.length > 0 && <p>Derived from {detail.dependencies.length} claims.</p>}
      {detail.dependents.length > 0 && <p>Supports {detail.dependents.length} other claims.</p>}
      {detail.links.map(link => <p key={`${link.source_id}:${link.target_id}:${link.relation}`}>{link.relation}: {link.source_id === detail.claim.id ? link.target_id : link.source_id}</p>)}
      {detail.history.map((item, index) => <p key={index}>{new Date(item.changed_at).toLocaleString()} · {item.status}</p>)}
      {detail.reviews.map((item, index) => <p key={`review:${index}`}>{item.actor}: {item.reason}</p>)}
    </details>
    <SensitivityControl kind="claim" id={detail.claim.id} label="Claim" />
    <details className="reader-disclosure knowledge-panel"><summary>Review this claim</summary>
      {error && <p role="alert" className="error-note">{error}</p>}
      <label>Review decision<select value={status} onChange={event => setStatus(event.target.value as ClaimStatus)}>{(['accepted', 'rejected', 'disputed', 'retracted'] as ClaimStatus[]).map(status => <option key={status}>{status}</option>)}</select></label>
      <label>Reason<textarea value={reason} onChange={event => setReason(event.target.value)} /></label>
      <button disabled={busy || !reason.trim()} onClick={review}>{busy ? 'Saving…' : 'Save review'}</button>
    </details>
  </article>;
}
