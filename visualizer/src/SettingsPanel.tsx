import { useEffect, useState } from "react";
import { RotateCcw, Search } from "lucide-react";
import { request } from "./api";
import { post } from "./control-api";
import { SettingField } from "./SettingField";
import type { SettingsDocument, SettingsTarget } from "./control-types";

export function SettingsPanel() {
  const [targets, setTargets] = useState<SettingsTarget[]>([]);
  const [target, setTarget] = useState("");
  const [document, setDocument] = useState<SettingsDocument | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [resetting, setResetting] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    request<{ targets: SettingsTarget[] }>("/api/settings", { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setTargets(result.targets); setTarget(result.targets[0]?.name ?? "");
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!target) return;
    const controller = new AbortController();
    setError(null); setDocument(null);
    request<SettingsDocument>(`/api/settings/${encodeURIComponent(target)}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setDocument(result);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [target, revision]);
  const activeTarget = targets.find(item => item.name === target);
  const keys = document ? [...new Set([...Object.keys(document.schema), ...Object.keys(document.values)])].filter(key => !key.includes("API_KEY")) : [];
  const visible = keys.filter(key => `${key} ${document?.schema[key]?.description ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  async function save(key: string, value: string) {
    const result = await post<{ newValue: unknown }>(`/api/settings/${encodeURIComponent(target)}`, { key, value });
    setDocument(current => current?.name === target ? { ...current, values: { ...current.values, [key]: result.newValue } } : current);
  }
  async function reset(key?: string) {
    const result = await post<{ settings: Record<string, unknown> }>(`/api/settings/${encodeURIComponent(target)}/reset`, { key });
    setDocument(current => current?.name === target ? { ...current, values: result.settings } : current);
  }
  async function resetAll() {
    if (!window.confirm(`Reset all documented settings for ${target} to their defaults?`)) return;
    setResetting(true); setError(null);
    try { await reset(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Reset failed."); }
    finally { setResetting(false); }
  }
  return <main className="control-page settings-page"><div className="page-intro"><p className="eyebrow">configuration</p><h1>Settings</h1><p>Changes save directly to disk and are available to running extensions immediately.</p></div>
    <div className="settings-layout"><aside className="settings-targets" aria-label="Settings targets"><p className="section-label">Host & extensions</p>{targets.map(item => <button key={item.name} className={item.name === target ? "target-button active" : "target-button"} onClick={() => { setTarget(item.name); setQuery(""); }}><span>{item.name === "root" ? "Shale host" : item.name}</span><small>{item.hasSettings || item.hasHelp ? "Settings" : "No configuration"}</small></button>)}</aside>
      <section className="control-card settings-document"><div className="card-heading"><div><p className="eyebrow">{target || "configuration"}</p><h2>{activeTarget?.title ?? "Loading settings…"}</h2></div><div className="settings-actions"><button className="action-button" onClick={() => setRevision(value => value + 1)} disabled={!target || resetting}><RotateCcw size={14} /> Reload</button><button className="text-button" onClick={resetAll} disabled={!document || !Object.keys(document.schema).length || resetting}>Reset all</button></div></div>
        <p className="quiet">{activeTarget?.description}</p>{target === "root" && <p className="settings-note">Model and batching settings apply on the next request. Port and database changes require restarting Shale. API keys remain in .env.</p>}
        <label className="settings-filter"><Search size={15} /><span className="sr-only">Filter settings</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a setting" /></label>
        {error && <p className="error-note" role="alert">{error}</p>}{!document && !error && <p className="quiet">Reading settings…</p>}
        {document && <fieldset className="settings-fields" disabled={resetting}>{visible.map(key => <SettingField key={`${target}:${key}`} name={key} value={document.values[key]} schema={document.schema[key]} onSave={value => save(key, value)} onReset={() => reset(key)} />)}</fieldset>}
        {document && !visible.length && <p className="quiet">{keys.length ? "No settings match your search." : "This extension has no configurable settings."}</p>}
      </section></div>
  </main>;
}
