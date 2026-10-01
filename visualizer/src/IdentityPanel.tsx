import { useEffect, useState } from 'react';
import { request, updateKnowledge } from './api';
import type { GraphNode } from './types';

interface Identity {
  aliases:Array<{alias:string;scope:string}>;
  merges:Array<{id:string;reason:string;undone_at:number|null}>;
}
export function IdentityPanel({node,nodes,onChanged}: {node:GraphNode;nodes:GraphNode[];onChanged:()=>void}) {
  const [name,setName]=useState(node.name);
  const [into,setInto]=useState('');
  const [reason,setReason]=useState('');
  const [identity,setIdentity]=useState<Identity|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [revision,setRevision]=useState(0);
  useEffect(()=> {
    let cancelled=false;
    setName(node.name);setInto('');setError('');
    request<Identity>(`/api/knowledge/entity?id=${node.id}`).then(result=>{if (!cancelled) setIdentity(result);})
      .catch(e=>{if (!cancelled) setError(e.message);});
    return ()=>{cancelled=true;};
  },[node.id,node.name,revision]);
  async function save(action:string,body:unknown) {
    setBusy(true);setError('');
    try {await updateKnowledge(action,body);setRevision(r=>r+1);onChanged();}
    catch(e) {setError(e instanceof Error ? e.message : 'Unable to update identity');}
    finally {setBusy(false);}
  }
  return <details className="reading-section knowledge-panel"><summary>Identity and corrections</summary>
    {error && <p role="alert" className="error-note">{error}</p>}
    <label>Display name<input value={name} onChange={e=>setName(e.target.value)} /></label>
    <button disabled={busy || !name.trim()} onClick={()=>save('entity',{id:node.id,name})}>Rename</button>
    <p className="quiet">Aliases: {identity?.aliases.map(a=>a.alias).join(', ') || 'none'}</p>
    <label>Merge into<select value={into} onChange={e=>setInto(e.target.value)}>
      <option value="">Choose the matching entry</option>
      {nodes.filter(n=>n.id!==node.id && n.type===node.type && n.canonicalId===null).map(n=><option key={n.id} value={n.id}>{n.name} · {n.namespace} · {n.id}</option>)}
    </select></label>
    <label>Reason<input value={reason} onChange={e=>setReason(e.target.value)} /></label>
    <button disabled={busy || !into || !reason.trim() || node.canonicalId!==null} onClick={()=>save('merge',{from:node.id,into:Number(into),reason})}>Merge entries</button>
    {identity?.merges.filter(m=>m.undone_at===null).map(m=><p key={m.id}>{m.reason} <button disabled={busy} onClick={()=>save('unmerge',{changeId:m.id})}>Undo merge</button></p>)}
  </details>;
}
