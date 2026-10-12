import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { request } from './api';
import type { AccessTier, RecordAccess } from './control-types';

const TIERS: AccessTier[] = ['public', 'personal', 'private', 'secret'];
const ORIGIN_LABELS: Record<string, string> = { manual: 'Set by you', llm: 'Model', heuristic: 'Heuristic' };

/** Shows a record's effective sensitivity tier and why, and lets the user pin a tier. */
export function SensitivityControl({ kind, id, label }: { kind: 'source' | 'entity' | 'claim'; id: string | number; label: string }) {
  const [access, setAccess] = useState<RecordAccess | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const path = `/api/access/labels?kind=${kind}&id=${encodeURIComponent(String(id))}`;
  useEffect(() => {
    const controller = new AbortController();
    setAccess(null); setError('');
    request<RecordAccess>(path, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setAccess(result); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [path]);
  async function choose(value: string) {
    setBusy(true); setError('');
    try {
      setAccess(value === 'auto'
        ? await request<RecordAccess>(path, { method: 'DELETE' })
        : await request<RecordAccess>('/api/access/labels', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, id, tier: value }) }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save the tier'); }
    finally { setBusy(false); }
  }
  if (error && !access) return null;
  const manual = access?.labels.find(item => item.origin === 'manual');
  const automatic = access?.labels.filter(item => item.origin !== 'manual') ?? [];
  return <section className="sensitivity-control">
    <div className="reader-section-heading"><h3><ShieldCheck size={14} /> {label} sensitivity</h3>
      {access?.tier && <span className={`tier-badge ${access.tier}`}>{access.tier}</span>}</div>
    {!access && <p className="quiet" role="status">Loading…</p>}
    {access && <>
      <label className="sensitivity-select">Agents with this clearance or higher can see it
        <select value={manual?.tier ?? 'auto'} disabled={busy} onChange={event => void choose(event.target.value)}>
          <option value="auto">Automatic</option>
          {TIERS.map(tier => <option key={tier} value={tier}>{tier}</option>)}
        </select>
      </label>
      {automatic.map(item => <p key={item.origin} className="quiet">{ORIGIN_LABELS[item.origin]}: {item.tier}{item.hard ? ' (credential or account number)' : ''} · {item.reason}</p>)}
      {!automatic.length && !manual && <p className="quiet">Not classified yet; restricted agents cannot see it until it is.</p>}
      {error && <p className="error-note" role="alert">{error}</p>}
    </>}
  </section>;
}
