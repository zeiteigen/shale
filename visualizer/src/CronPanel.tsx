import { useState } from "react";
import { Play } from "lucide-react";
import { post } from "./control-api";
import type { Cron } from "./control-types";

export function CronPanel({ crons, busy, onChanged }: { crons: Cron[]; busy: boolean; onChanged: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(id: string) {
    setPending(true); setError(null);
    try { await post("/api/crons/run", { id }); onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to start job."); }
    finally { setPending(false); }
  }
  return <section className="control-card jobs-card">
    <div className="card-heading"><div><p className="eyebrow">automation</p><h2>Background jobs</h2></div>
      <button className="action-button" disabled={busy || pending || !crons.length} onClick={() => run("all")}><Play size={14} /> Run all</button></div>
    <p className="quiet">Scheduled jobs run automatically. Run all executes each job in sequence.</p>
    {error && <p className="error-note" role="alert">{error}</p>}
    <div className="table-scroll"><table className="jobs-table"><thead><tr><th>Job / extension</th><th>Schedule</th><th>Latest run</th><th><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{crons.map(cron => <tr key={cron.id}><td><strong>{cron.name ?? cron.extensionId ?? "Unnamed job"}</strong><small>{cron.extensionId}{cron.run_on_startup ? " · runs on startup" : ""}</small></td>
        <td><code>{cron.schedule}</code></td><td><span className={`run-status ${cron.lastRun?.status ?? "idle"}`}>{cron.lastRun?.status ?? "Not run yet"}</span>
          {cron.lastRun && <small>{new Date(cron.lastRun.finishedAt ?? cron.lastRun.startedAt).toLocaleTimeString()}</small>}{cron.lastRun?.error && <small className="job-error">{cron.lastRun.error}</small>}</td>
        <td><button aria-label={`Run ${cron.name ?? cron.extensionId ?? "job"}`} disabled={busy || pending || cron.lastRun?.status === "running"} className="action-button" onClick={() => run(cron.id)}><Play size={13} /> Run</button></td></tr>)}</tbody></table></div>
    {!crons.length && <p className="quiet">No scheduled jobs are registered.</p>}
  </section>;
}
