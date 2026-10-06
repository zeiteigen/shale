import { useState } from "react";
import { post } from "./control-api";
import type { Task } from "./control-types";

export function CommandPanel({ tasks, onChanged }: { tasks: Task[]; onChanged: () => void }) {
  const [command, setCommand] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = pending || tasks.some(task => task.status === "running");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setPending(true); setError(null);
    try { await post("/api/command", { command }); setCommand(""); onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Command failed."); }
    finally { setPending(false); }
  }
  return <section className="control-card command-card"><div className="card-heading"><div><p className="eyebrow">host controls</p><h2>Command console</h2></div></div>
    <form onSubmit={submit} className="command-form"><label htmlFor="host-command">Shale command</label><div className="command-input"><span aria-hidden="true">›</span><input id="host-command" value={command} onChange={event => setCommand(event.target.value)} list="command-suggestions" placeholder="help, status, cron list, settings get root" autoComplete="off" /><button className="action-button" disabled={busy || !command.trim()}>Run</button></div>
      <datalist id="command-suggestions">{["help", "status", "cron list", "cron run all", "settings list-targets", "settings list root"].map(item => <option key={item} value={item} />)}</datalist></form>
    <p className="quiet">Use the Settings tab for guided editing. Type help for the command reference.</p>
    {error && <p className="error-note" role="alert">{error}</p>}
    <div className="task-history" aria-live="polite">{tasks.slice(0, 10).map(task => <article key={task.id}><div><strong>{task.label}</strong><span className={`run-status ${task.status}`}>{task.status}</span></div>{task.output && <pre>{task.output}</pre>}{task.status === "running" && <p className="quiet">Running in the background…</p>}</article>)}</div>
  </section>;
}
