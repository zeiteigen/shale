import { useEffect, useState } from 'react';
import { request, updateKnowledge } from './api';
import type { Claim, Evidence, ClaimStatus } from '../../sdk/graph/types';
import type { GraphNode } from './types';

interface Inspection {
  claim:Claim; evidence:Evidence[]; dependencies:string[]; dependents:string[];
  reviews:Array<{status:string;actor:string;reason:string;reviewed_at:number}>;
  history:Array<{status:string;changed_at:number}>;
  links:Array<{relation:string;source_id:string;target_id:string}>;
}

export function ClaimPanel({node,nodes,onChanged,context,at}: {
  node:GraphNode;nodes:GraphNode[];onChanged:()=>void;context?:string;at?:number;
}) {
  const [claims,setClaims]=useState<Claim[]>([]);
  const [detail,setDetail]=useState<Inspection|null>(null);
  const [reason,setReason]=useState('');
  const [error,setError]=useState('');
  const [status,setStatus]=useState<ClaimStatus>('accepted');
  const [busy,setBusy]=useState(false);
  const [revision,setRevision]=useState(0);
  useEffect(()=> {
    let cancelled=false;
    setDetail(null);setError('');
    updateKnowledge<{claims:Claim[]}>('claims',{entityId:node.id,context,at,limit:200})
      .then(result=>{if (!cancelled) setClaims(result.claims);}).catch(e=>{if (!cancelled) setError(e.message);});
    return ()=>{cancelled=true;};
  },[node.id,context,at,revision]);
  async function inspect(claim:Claim) {
    setBusy(true);setError('');setReason('');
    try {setDetail(await request<Inspection>(`/api/knowledge/inspect?id=${encodeURIComponent(claim.id)}`));}
    catch(e) {setError(e instanceof Error ? e.message : 'Unable to inspect claim');}
    finally {setBusy(false);}
  }
  async function review() {
    if (!detail) return;
    setBusy(true);setError('');
    try {
      await updateKnowledge('review',{id:detail.claim.id,status,reason,actor:'user'});
      setRevision(r=>r+1);onChanged();
    } catch(e) {setError(e instanceof Error ? e.message : 'Unable to save review');}
    finally {setBusy(false);}
  }
  const label=(claim:Claim)=>claim.object === undefined ? `${JSON.stringify(claim.value)}${claim.unit ? ` ${claim.unit}` : ''}`
    : nodes.find(n=>n.id===claim.object)?.name ?? `Entry ${claim.object}`;
  return <section className="reading-section knowledge-panel">
    <p className="section-label">Claims and evidence</p>
    {error && <p role="alert" className="error-note">{error}</p>}
    {claims.length===200 && <p className="quiet">Showing the first 200 claims.</p>}
    {claims.map(claim=><button className="claim-card" key={claim.id} disabled={busy} onClick={()=>inspect(claim)}>
      <span>{claim.polarity===-1 ? 'Does not: ' : ''}{claim.predicate.replaceAll('_',' ')} · {claim.status}</span>
      <strong>{label(claim)}</strong>{claim.context && <small>{claim.context}</small>}
    </button>)}
    {!claims.length && <p className="quiet">No claims recorded for this entry.</p>}
    {detail && <article className="claim-detail">
      <strong>{detail.claim.predicate.replaceAll('_',' ')}: {label(detail.claim)}</strong>
      <p>{detail.claim.status} · recorded {new Date(detail.claim.recordedAt).toLocaleString()}</p>
      {(detail.claim.validFrom!==undefined || detail.claim.validTo!==undefined) && <p>Valid {detail.claim.validFrom===undefined ? 'from an unknown date' : `from ${new Date(detail.claim.validFrom).toLocaleDateString()}`} {detail.claim.validTo===undefined ? 'onward' : `until ${new Date(detail.claim.validTo).toLocaleDateString()}`}</p>}
      {detail.claim.confidence!==undefined && <p>Extraction confidence: {Math.round(detail.claim.confidence*100)}%</p>}
      {Object.keys(detail.claim.qualifiers ?? {}).length>0 && <pre>{JSON.stringify(detail.claim.qualifiers,null,2)}</pre>}
      {detail.evidence.map(item=><blockquote key={item.id}>
        <p>{item.quote ?? 'Evidence attached to the source revision.'}</p>
        <cite>{item.title} · {item.stance}{item.stale ? ' · source has changed' : ''}</cite>
        <a href={`/api/knowledge/revision?id=${item.revisionId}`} target="_blank" rel="noreferrer">Read saved revision</a>
      </blockquote>)}
      {!detail.evidence.length && <p className="quiet">No source evidence is attached.</p>}
      {detail.dependencies.length>0 && <p>Derived from {detail.dependencies.length} claims.</p>}
      {detail.links.map(link=><p key={`${link.source_id}:${link.target_id}:${link.relation}`}>{link.relation}: {link.source_id===detail.claim.id ? link.target_id : link.source_id}</p>)}
      <details><summary>Status timeline</summary>{detail.history.map((item,index)=><p key={index}>{new Date(item.changed_at).toLocaleString()} · {item.status}</p>)}
        {detail.reviews.map((item,index)=><p key={`review:${index}`}>{item.actor}: {item.reason}</p>)}</details>
      <label>Review decision<select value={status} onChange={e=>setStatus(e.target.value as ClaimStatus)}>
        {(['accepted','rejected','disputed','retracted'] as ClaimStatus[]).map(s=><option key={s}>{s}</option>)}
      </select></label>
      <label>Reason<textarea value={reason} onChange={e=>setReason(e.target.value)} /></label>
      <button disabled={busy || !reason.trim()} onClick={review}>Save review</button>
    </article>}
  </section>;
}
