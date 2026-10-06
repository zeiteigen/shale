import { useEffect, useRef, useState } from "react";
import { usePoll } from "./use-poll";
import type { LogEntry } from "./control-types";

export function LogPanel() {
  const { data, error } = usePoll<{ entries: LogEntry[] }>("/api/logs");
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const output = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!paused && data) setEntries(data.entries); }, [data, paused]);
  useEffect(() => { if (follow && output.current) output.current.scrollTop = output.current.scrollHeight; }, [entries, follow]);
  return <section className="control-card logs-card"><div className="card-heading"><div><p className="eyebrow">activity</p><h2>Live output</h2></div><div className="log-actions"><label><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /> Follow</label><button className="action-button" onClick={() => setPaused(value => !value)}>{paused ? "Resume" : "Pause"}</button></div></div>
    {error && <p className="error-note" role="alert">{error}</p>}
    <div className="log-output" ref={output} tabIndex={0} aria-label="Host output">{entries.length ? entries.map(entry => <div key={entry.id} className={`log-line ${entry.level}`}><time>{new Date(entry.time).toLocaleTimeString()}</time><span>{entry.text}</span></div>) : <p>Output will appear when the host starts working.</p>}</div>
    <p className="quiet">Latest 500 messages from this host session.{paused ? " Display paused." : ""}</p>
  </section>;
}
