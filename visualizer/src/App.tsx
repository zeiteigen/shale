import { useEffect, useState } from "react";
import { Activity, Network, Settings, Square } from "lucide-react";
import { HostPanel } from "./HostPanel";
import { SettingsPanel } from "./SettingsPanel";
import Notebook from "./Notebook";
import { usePoll } from "./use-poll";
import { post } from "./control-api";
import type { Host } from "./control-types";
import "./controls.css";
import {getGraph} from './api';

const pages = [
  { id: "overview", title: "Overview", icon: Activity },
  { id: "settings", title: "Settings", icon: Settings },
  { id: "knowledge", title: "Knowledge", icon: Network },
] as const;
function currentPage() {
  const hash = window.location.hash.slice(1);
  return pages.some(page => page.id === hash) ? hash : "overview";
}

export default function App() {
  const [page, setPage] = useState(currentPage);
  const { data: host, error, refresh } = usePoll<Host>("/api/host");
  const [stopped, setStopped] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const connected=Boolean(host);
  useEffect(()=>{
    if(!connected)return;
    const timer=setTimeout(()=>{void getGraph().catch(()=>{});},1000);
    return()=>clearTimeout(timer);
  },[connected]);
  useEffect(() => {
    const update = () => setPage(currentPage());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  async function stop() {
    if (!window.confirm("Stop the Shale host? Running jobs will be interrupted. You will need to start Shale again to reconnect.")) return;
    setStopping(true); setStopError(null);
    try { await post("/api/shutdown", { confirm: true }); setStopped(true); }
    catch (reason) { setStopError(reason instanceof Error ? reason.message : "Shutdown failed."); }
    finally { setStopping(false); }
  }
  return <div className="app-shell"><header className="app-header"><a className="wordmark" href="#overview"><span className="wordmark-mark">S</span><span>Shale</span></a>
    <nav aria-label="Main navigation">{pages.map(({ id, title, icon: Icon }) => <a key={id} href={`#${id}`} className={page === id ? "nav-link active" : "nav-link"} aria-current={page === id ? "page" : undefined}><Icon size={16} />{title}</a>)}</nav>
    <div className="host-indicator"><i className={!error && host && !stopped ? "online-dot" : "offline-dot"} /><span>{stopped ? "Stopped" : error ? "Disconnected" : host ? "Local host" : "Connecting"}</span></div>
    <button className="stop-button" onClick={stop} disabled={stopped || stopping || !!error || !host}><Square size={13} /> Stop host</button></header>
    {!stopped && (error || stopError) && <div className="connection-error" role="alert">{stopError ?? `Cannot reach the Shale host: ${error}`}<button className="text-button" onClick={refresh}>Retry</button></div>}
    {stopped ? <main className="control-page"><h1>Shale has stopped.</h1><p>Start Shale again to resume your workspace, then reload this page.</p></main>
      : page === "settings" ? <SettingsPanel /> : page === "knowledge" ? <Notebook /> : <HostPanel host={host} onChanged={refresh} />}
  </div>;
}
