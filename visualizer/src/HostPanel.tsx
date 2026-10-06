import { CronPanel } from "./CronPanel";
import { CommandPanel } from "./CommandPanel";
import { LogPanel } from "./LogPanel";
import type { Host } from "./control-types";

function uptime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

export function HostPanel({ host, onChanged }: { host: Host | null; onChanged: () => void }) {
  if (!host) return <div className="control-page"><p className="quiet">Connecting to the local host…</p></div>;
  return <main className="control-page"><div className="page-intro"><p className="eyebrow">local workspace</p><h1>Shale at a glance</h1><p>Manage the host, run jobs, and follow your knowledge as it takes shape.</p></div>
    <div className="host-metrics"><article><span>Host</span><strong><i className="online-dot" /> Running</strong><small>Port {host.port}</small></article><article><span>Uptime</span><strong>{uptime(host.uptime)}</strong><small>Current session</small></article><article><span>Memory</span><strong>{host.memoryMB} <small>MB</small></strong><small>Resident memory</small></article><article><span>Extensions</span><strong>{host.extensions.length}</strong><small>{host.crons.length} background jobs</small></article></div>
    <div className="operations-grid"><CronPanel crons={host.crons} busy={host.tasks.some(task => task.status === "running")} onChanged={onChanged} /><CommandPanel tasks={host.tasks} onChanged={onChanged} /><LogPanel /></div>
    <section className="loaded-extensions"><h2>Loaded extensions</h2><div>{host.extensions.map(extension => <span key={extension.name} title={`Namespace: ${extension.namespace}`}>{extension.name}</span>)}</div></section>
  </main>;
}
