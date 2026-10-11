import { useEffect, useState } from "react";
import { KeyRound, LogOut, RefreshCw, ShieldAlert } from "lucide-react";
import { request } from "./api";
import { post } from "./control-api";
import type { AuthAccount, AuthField, AuthStatus } from "./control-types";

function Field({ field, value, onChange, disabled }: { field: AuthField; value: string; onChange: (value: string) => void; disabled: boolean }) {
  return <label className="auth-field"><span>{field.label}{field.required && <i aria-hidden="true"> *</i>}</span>
    <input type={field.type} value={value} onChange={event => onChange(event.target.value)} placeholder={field.placeholder}
      required={field.required} disabled={disabled} autoComplete={field.type === "password" ? "new-password" : "off"} spellCheck={false} />
    {field.help && <small>{field.help}</small>}</label>;
}

function AccountCard({ account, onStatus }: { account: AuthAccount; onStatus: (status: AuthStatus) => void }) {
  const { status } = account;
  const [method, setMethod] = useState(account.methods[0]?.id ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const active = account.methods.find(item => item.id === method);
  const base = `/api/auth/${encodeURIComponent(account.extension)}`;
  async function run(action: string, path: string, body: unknown) {
    setBusy(action); setError(null);
    try {
      const result = await post<{ status: AuthStatus }>(`${base}/${path}`, body);
      onStatus(result.status);
      if (!result.status.pending) { setValues({}); setEditing(false); }
      else setValues(current => ({ ...current, [result.status.pending!.field.key]: "" }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Request failed."); }
    finally { setBusy(null); }
  }
  const showForm = !status.pending && (!status.connected || editing);
  return <section className="control-card auth-card">
    <div className="card-heading"><div><p className="eyebrow">{account.extension}</p><h2>{account.title}</h2></div>
      <span className={status.connected ? "run-status succeeded" : status.pending ? "run-status running" : "run-status"}>
        {status.connected ? "connected" : status.pending ? "waiting for code" : "not connected"}</span></div>
    {account.description && <p className="quiet">{account.description}</p>}
    {account.warning && <p className="auth-warning"><ShieldAlert size={14} /> {account.warning}</p>}
    {status.connected && <div className="auth-account"><KeyRound size={15} /><div><strong>{status.account ?? "Connected"}</strong>
      {status.detail && <small>{status.detail}</small>}
      {status.checkedAt && <small>Last checked {new Date(status.checkedAt).toLocaleString()}</small>}</div></div>}
    {!status.connected && status.detail && <p className="quiet">{status.detail}</p>}
    {(error ?? status.error) && <p className="field-error" role="alert">{error ?? status.error}</p>}
    {status.pending && <form className="auth-form" onSubmit={event => { event.preventDefault(); void run("submit", "submit", { values }); }}>
      <p className="settings-note">{status.pending.prompt}</p>
      <Field field={status.pending.field} value={values[status.pending.field.key] ?? ""} disabled={!!busy}
        onChange={value => setValues(current => ({ ...current, [status.pending!.field.key]: value }))} />
      <div className="field-actions"><button className="action-button primary" disabled={!!busy}>{busy === "submit" ? "Checking…" : "Continue"}</button>
        <button type="button" className="text-button" disabled={!!busy} onClick={() => run("cancel", "disconnect", { confirm: true })}>Cancel</button></div>
    </form>}
    {showForm && active && <form className="auth-form" onSubmit={event => { event.preventDefault(); void run("connect", "connect", { method, values }); }}>
      {account.methods.length > 1 && <div className="auth-methods" role="tablist">{account.methods.map(item =>
        <button key={item.id} type="button" role="tab" aria-selected={item.id === method} className={item.id === method ? "target-button active" : "target-button"}
          onClick={() => { setMethod(item.id); setValues({}); setError(null); }} disabled={!!busy}><span>{item.label}</span></button>)}</div>}
      {active.description && <p className="quiet">{active.description}</p>}
      {active.fields.map(field => <Field key={field.key} field={field} value={values[field.key] ?? ""} disabled={!!busy}
        onChange={value => setValues(current => ({ ...current, [field.key]: value }))} />)}
      <div className="field-actions"><button className="action-button primary" disabled={!!busy}>{busy === "connect" ? "Connecting…" : status.connected ? "Replace credentials" : "Connect"}</button>
        {editing && <button type="button" className="text-button" onClick={() => { setEditing(false); setValues({}); setError(null); }}>Cancel</button>}</div>
      <p className="quiet">Stored only on this machine in data/credentials.json and never sent back to the browser.</p>
    </form>}
    {status.connected && !editing && <div className="settings-actions auth-actions">
      {account.canVerify && <button className="action-button" disabled={!!busy} onClick={() => run("verify", "verify", {})}><RefreshCw size={14} /> {busy === "verify" ? "Checking…" : "Check connection"}</button>}
      <button className="action-button" disabled={!!busy} onClick={() => { setEditing(true); setError(null); }}>Change</button>
      <button className="text-button" disabled={!!busy} onClick={() => {
        if (window.confirm(`Disconnect ${account.title}? Stored credentials and sessions for it will be deleted from this machine.`)) void run("disconnect", "disconnect", { confirm: true });
      }}><LogOut size={13} /> Disconnect</button></div>}
  </section>;
}

export function AccountsPanel() {
  const [accounts, setAccounts] = useState<AuthAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    request<{ accounts: AuthAccount[] }>("/api/auth", { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setAccounts(result.accounts); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, []);
  function update(extension: string, status: AuthStatus) {
    setAccounts(current => current?.map(account => account.extension === extension ? { ...account, status } : account) ?? null);
  }
  return <main className="control-page"><div className="page-intro"><p className="eyebrow">connections</p><h1>Accounts</h1>
    <p>Connect the services that extensions sync from. Credentials stay on this machine and are only used by the local host.</p></div>
    {error && <p className="error-note" role="alert">{error}</p>}
    {!accounts && !error && <p className="quiet">Loading accounts…</p>}
    {accounts && !accounts.length && <p className="quiet">No installed extension needs an account.</p>}
    <div className="auth-grid">{accounts?.map(account => <AccountCard key={account.extension} account={account} onStatus={status => update(account.extension, status)} />)}</div>
  </main>;
}
