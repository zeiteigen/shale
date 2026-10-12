import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { request } from "./api";
import { post } from "./control-api";
import type { AccessOverview, AccessPolicy, AccessProfile, AccessTier, ProfilePreview, SourceMatch } from "./control-types";

const TIER_HELP: Record<AccessTier, string> = {
  public: "Published or widely known",
  personal: "Your notes, work, and interests",
  private: "Health, money, messages, contacts",
  secret: "Credentials and account numbers",
};

function TierSelect({ value, onChange, inherit, label }: { value: AccessTier | ""; onChange: (tier: AccessTier | "") => void; inherit?: string; label: string }) {
  return <select aria-label={label} value={value} onChange={event => onChange(event.target.value as AccessTier | "")}>
    {inherit !== undefined && <option value="">{inherit}</option>}
    {(Object.keys(TIER_HELP) as AccessTier[]).map(tier => <option key={tier} value={tier}>{tier}</option>)}
  </select>;
}

function ProfileCard({ name, profile, preview, origins, tokens, isDefault, canRemove, onChange, onRemove, onTokens }: {
  name: string; profile: AccessProfile; preview?: ProfilePreview; origins: string[]; tokens: AccessOverview["tokens"];
  isDefault: boolean; canRemove: boolean; onChange: (profile: AccessProfile) => void; onRemove: () => void; onTokens: () => void;
}) {
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hidden = new Set((profile.deny ?? []).filter(match => match.origin && !match.type && !match.uri).map(match => match.origin!));
  const unrestricted = profile.clearance === "secret" && !profile.allow?.length && !profile.deny?.length;
  function toggleOrigin(origin: string) {
    const others = (profile.deny ?? []).filter(match => !(match.origin === origin && !match.type && !match.uri));
    onChange({ ...profile, deny: hidden.has(origin) ? others : [...others, { origin }] });
  }
  async function createToken() {
    setError(null);
    try {
      const result = await post<{ token: { token: string } }>("/api/access/tokens", { profile: name, label });
      setCreated(result.token.token); setLabel(""); onTokens();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to create a token."); }
  }
  async function revoke(id: string) {
    if (!window.confirm("Revoke this token? Agents using it lose access immediately.")) return;
    try { await request(`/api/access/tokens/${id}`, { method: "DELETE" }); onTokens(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to revoke the token."); }
  }
  return <section className="control-card access-card">
    <div className="card-heading"><div><p className="eyebrow">profile</p><h2>{name}</h2></div>
      <span className={unrestricted ? "run-status succeeded" : "run-status running"}>{unrestricted ? "full access" : "restricted"}</span></div>
    <label className="auth-field"><span>Description</span>
      <input value={profile.description ?? ""} onChange={event => onChange({ ...profile, description: event.target.value })} placeholder="Who uses this profile" /></label>
    <label className="auth-field"><span>Clearance</span>
      <TierSelect label={`${name} clearance`} value={profile.clearance} onChange={tier => tier && onChange({ ...profile, clearance: tier })} />
      <small>Sees records up to <strong>{profile.clearance}</strong>: {(Object.keys(TIER_HELP) as AccessTier[])
        .slice(0, (Object.keys(TIER_HELP) as AccessTier[]).indexOf(profile.clearance) + 1).map(tier => TIER_HELP[tier].toLowerCase()).join("; ")}.</small></label>
    <label className="access-check"><input type="checkbox" checked={profile.write !== false} onChange={event => onChange({ ...profile, write: event.target.checked })} />
      Can edit the records it can see</label>
    {origins.length > 0 && <fieldset className="access-origins"><legend>Hide these sources entirely</legend>
      {origins.map(origin => <label key={origin} className="access-check"><input type="checkbox" checked={hidden.has(origin)} onChange={() => toggleOrigin(origin)} />{origin}</label>)}
    </fieldset>}
    {preview && <div className="access-preview">{preview.error ? <p className="field-error">{preview.error}</p> : <>
      <p><strong>{preview.sources}</strong> sources · <strong>{preview.entities}</strong> entities · <strong>{preview.claims}</strong> claims visible</p>
      {preview.origins && preview.origins.length > 0 && <small>{preview.origins.map(item => `${item.origin} ${item.n}`).join(" · ")}</small>}
      <small>Based on saved settings.</small></>}</div>}
    <div className="access-tokens">
      <p className="eyebrow">tokens{isDefault ? " · also used without a token" : ""}</p>
      {tokens.map(token => <div key={token.id} className="access-token"><KeyRound size={13} /><span>{token.label || "Unnamed"}<small>Created {new Date(token.createdAt).toLocaleDateString()} · {token.id}</small></span>
        <button className="text-button" onClick={() => void revoke(token.id)}>Revoke</button></div>)}
      {created && <div className="access-reveal" role="status"><p>Copy this token now; it will not be shown again. Agents send it as <code>Authorization: Bearer …</code>.</p>
        <div><code>{created}</code><button className="action-button" onClick={() => void navigator.clipboard?.writeText(created)}><Copy size={13} /> Copy</button></div></div>}
      <form className="access-inline" onSubmit={event => { event.preventDefault(); void createToken(); }}>
        <input aria-label={`New ${name} token label`} value={label} onChange={event => setLabel(event.target.value)} placeholder="Label, e.g. cloud agent" />
        <button className="action-button"><Plus size={13} /> New token</button></form>
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
    {canRemove && <div className="settings-actions"><button className="text-button" onClick={onRemove}><Trash2 size={13} /> Remove profile</button></div>}
  </section>;
}

export function AccessPanel() {
  const [overview, setOverview] = useState<AccessOverview | null>(null);
  const [draft, setDraft] = useState<AccessPolicy | null>(null);
  const [preview, setPreview] = useState<Record<string, ProfilePreview>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [newProfile, setNewProfile] = useState("");
  const load = useCallback(async (keepDraft = false) => {
    try {
      const result = await request<AccessOverview>("/api/access");
      setOverview(result);
      if (!keepDraft) setDraft(result.policy);
      request<{ profiles: Record<string, ProfilePreview> }>("/api/access/preview").then(data => setPreview(data.profiles)).catch(() => {});
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load access settings."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!overview || !draft) return <main className="control-page">{error ? <p className="error-note" role="alert">{error}</p> : <p className="quiet">Loading access settings…</p>}</main>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(overview.policy);
  const origins = [...new Set([...overview.origins.map(item => item.origin), ...Object.keys(draft.originTiers)])];
  const update = (next: AccessPolicy) => { setDraft(next); setSaved(false); };
  const setProfile = (name: string, profile: AccessProfile) => update({ ...draft, profiles: { ...draft.profiles, [name]: profile } });
  function setRule(index: number, rule: { match: SourceMatch; tier: AccessTier } | null) {
    const rules = [...draft!.tierRules];
    if (rule) rules[index] = rule; else rules.splice(index, 1);
    update({ ...draft!, tierRules: rules });
  }
  async function save() {
    setSaving(true); setError(null);
    try {
      await request("/api/access", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policy: draft }) });
      setSaved(true); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save."); }
    finally { setSaving(false); }
  }
  const { classification } = overview;
  return <main className="control-page access-page"><div className="page-intro"><p className="eyebrow">permissions</p><h1>Access</h1>
    <p>Decide which of your data each agent can use. Every source, entity, and claim gets a sensitivity tier automatically; an agent sees only records at or below its profile's clearance.</p></div>
    <p className="settings-note">{classification.heuristic} of {classification.sources} sources classified by heuristics, {classification.llm} refined by the model
      {classification.manual ? `, ${classification.manual} records set by you` : ""}. Restricted agents never see records that have not been classified yet.</p>
    {error && <p className="error-note" role="alert">{error}</p>}
    <section className="control-card access-defaults">
      <div className="card-heading"><div><p className="eyebrow">sensitivity</p><h2>Minimum tiers</h2></div></div>
      <p className="quiet">Automatic classification can raise a record above these floors but never lower it below them. Tiers you set on a record override both.</p>
      <div className="table-scroll"><table className="jobs-table"><thead><tr><th>Source</th><th>Records</th><th>Minimum tier</th></tr></thead><tbody>
        <tr><td><strong>Everything else</strong></td><td /><td><TierSelect label="Default tier" value={draft.defaultTier} onChange={tier => tier && update({ ...draft, defaultTier: tier })} /></td></tr>
        {origins.map(origin => <tr key={origin}><td><strong>{origin}</strong></td><td>{overview.origins.find(item => item.origin === origin)?.n ?? 0}</td>
          <td><TierSelect label={`${origin} tier`} value={draft.originTiers[origin] ?? ""} inherit={`default (${draft.defaultTier})`} onChange={tier => {
            const originTiers = { ...draft.originTiers };
            if (tier) originTiers[origin] = tier; else delete originTiers[origin];
            update({ ...draft, originTiers });
          }} /></td></tr>)}
      </tbody></table></div>
      <h3 className="access-subheading">Pattern rules</h3>
      <p className="quiet">The first matching rule sets the floor. Patterns use <code>*</code> wildcards, e.g. URI <code>*bank*</code>.</p>
      {draft.tierRules.map((rule, index) => <div key={index} className="access-rule">
        {(["origin", "type", "uri"] as const).map(field => <input key={field} aria-label={`Rule ${index + 1} ${field}`} placeholder={field} value={rule.match[field] ?? ""}
          onChange={event => {
            const match = { ...rule.match, [field]: event.target.value };
            if (!event.target.value) delete match[field];
            setRule(index, { ...rule, match });
          }} />)}
        <TierSelect label={`Rule ${index + 1} tier`} value={rule.tier} onChange={tier => tier && setRule(index, { ...rule, tier })} />
        <button className="text-button" aria-label={`Remove rule ${index + 1}`} onClick={() => setRule(index, null)}><Trash2 size={13} /></button></div>)}
      <button className="action-button" onClick={() => update({ ...draft, tierRules: [...draft.tierRules, { match: { uri: "" }, tier: "private" }] })}><Plus size={13} /> Add rule</button>
      <label className="auth-field access-unauthenticated"><span>Requests without a token</span>
        <select value={draft.unauthenticatedProfile ?? ""} onChange={event => update({ ...draft, unauthenticatedProfile: event.target.value || null })}>
          {Object.keys(draft.profiles).map(name => <option key={name} value={name}>Use the {name} profile</option>)}
          <option value="">Reject; a token is required</option>
        </select>
        <small>Before exposing the MCP server through a tunnel, require a token or pick a restricted profile here.</small></label>
    </section>
    <div className="auth-grid access-profiles">
      {Object.entries(draft.profiles).map(([name, profile]) => <ProfileCard key={name} name={name} profile={profile} preview={preview[name]}
        origins={origins} tokens={overview.tokens.filter(token => token.profile === name)} isDefault={draft.unauthenticatedProfile === name}
        canRemove={Object.keys(draft.profiles).length > 1 && draft.unauthenticatedProfile !== name}
        onChange={next => setProfile(name, next)} onTokens={() => void load(true)}
        onRemove={() => { const profiles = { ...draft.profiles }; delete profiles[name]; update({ ...draft, profiles }); }} />)}
      <form className="control-card access-new" onSubmit={event => {
        event.preventDefault();
        const name = newProfile.trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || draft.profiles[name]) { setError("Profile names use lowercase letters, digits, - or _, and must be unique."); return; }
        setProfile(name, { clearance: "public", write: false }); setNewProfile("");
      }}>
        <p className="eyebrow">new profile</p>
        <div className="access-inline"><input aria-label="New profile name" value={newProfile} onChange={event => setNewProfile(event.target.value)} placeholder="e.g. research-agent" />
          <button className="action-button"><Plus size={13} /> Add profile</button></div>
        <p className="quiet">New profiles start read-only with public clearance.</p>
      </form>
    </div>
    <div className="access-savebar">
      {saved && !dirty && <span className="field-success">Saved. Running agents use the new permissions on their next request.</span>}
      {dirty && <span className="quiet">Unsaved changes</span>}
      <button className="text-button" disabled={!dirty || saving} onClick={() => update(overview.policy)}>Discard</button>
      <button className="action-button primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save changes"}</button>
    </div>
  </main>;
}
