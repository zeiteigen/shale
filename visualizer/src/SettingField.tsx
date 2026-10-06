import { useEffect, useState } from "react";
import type { SettingSchema } from "./control-types";

function textValue(value: unknown) {
  return value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function SettingField({ name, value, schema, onSave, onReset }: {
  name: string;
  value: unknown;
  schema?: SettingSchema;
  onSave: (value: string) => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(textValue(value));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => { setDraft(textValue(value)); }, [value]);
  function edit(next: string) { setDraft(next); setError(null); setMessage(""); }
  const type = schema?.type ?? (Array.isArray(value) ? "array" : typeof value);
  const id = `setting-${name}`;
  const options = type === "boolean" ? [true, false] : schema?.possibleValues;
  const isStructured = ["array", "object", "string[]"].includes(type);
  async function update(reset: boolean) {
    setPending(true); setError(null); setMessage("");
    try { if (reset) await onReset(); else await onSave(draft); setMessage(reset ? "Reset to default." : "Saved."); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save setting."); }
    finally { setPending(false); }
  }
  return <form className="setting-field" onSubmit={event => { event.preventDefault(); void update(false); }}>
    <div className="setting-description"><label htmlFor={id}>{name}</label><span className="setting-type">{type}</span><p>{schema?.description ?? "Custom setting stored in settings.json."}</p>
      {schema && <small>Default: <code>{schema.default === undefined || schema.default === null ? "unset" : textValue(schema.default)}</code>{schema.range && ` · Range: ${schema.range.min ?? "any"}–${schema.range.max ?? "any"}`}{schema.integer ? " · Whole numbers" : ""}</small>}
      {value === undefined && <small>Not set in this file; runtime defaults or environment values apply.</small>}</div>
    <div className="setting-editor">{options ? <select id={id} value={draft} onChange={event => edit(event.target.value)} disabled={pending}>
      {value === undefined && draft === "" && !options.includes("") && <option value="" disabled>Not set</option>}
      {options.map(option => <option key={textValue(option)} value={textValue(option)}>{textValue(option) || "(empty)"}</option>)}</select>
      : isStructured ? <textarea id={id} value={draft} onChange={event => edit(event.target.value)} rows={4} disabled={pending} spellCheck={false} placeholder={textValue(schema?.default)} />
      : <input id={id} value={draft} onChange={event => edit(event.target.value)} type={type === "number" ? "number" : schema?.format === "url" ? "url" : "text"} min={schema?.range?.min} max={schema?.range?.max} step={schema?.integer ? 1 : "any"} placeholder={schema?.default == null ? "Not set" : textValue(schema.default)} disabled={pending} />}
      <div className="field-actions"><button className="action-button primary" disabled={pending || draft === textValue(value)}>{pending ? "Saving…" : "Save"}</button>{schema && <button type="button" className="text-button" disabled={pending} onClick={() => update(true)}>Reset</button>}</div>
      {error && <p className="field-error" role="alert">{error}</p>}{message && <p className="field-success" role="status">{message}</p>}
    </div>
  </form>;
}
