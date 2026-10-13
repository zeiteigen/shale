import { useEffect, useState } from "react";
import { request } from "./api";
import { useDebouncedValue } from "./use-debounced-value";

interface EpisodeSummary {
  id: number; title: string; kind: string; status: string; summary: string;
  startedAt: number | null; lastActivityAt: number | null; members: number; origins: string[];
}
interface Episode extends Omit<EpisodeSummary, "members" | "origins"> {
  members: Array<{ sourceId: string; title: string; origin: string; uri: string; at: number | null; role: string; step: string;
    status: string; summary: string }>;
  involves: Array<{ id: number; name: string; type: string }>;
}

const day = (ms: number | null) => ms === null ? "undated" : new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const span = (episode: { startedAt: number | null; lastActivityAt: number | null }) =>
  episode.startedAt === episode.lastActivityAt ? day(episode.startedAt) : `${day(episode.startedAt)} – ${day(episode.lastActivityAt)}`;

/** The user's pursuits across sources: a list, and one episode's timeline. */
export function EpisodesPanel() {
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, 250);
  const [episodes, setEpisodes] = useState<EpisodeSummary[] | null>(null);
  const [selected, setSelected] = useState<Episode | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    request<{ episodes: EpisodeSummary[] }>(`/api/knowledge/episodes?${new URLSearchParams(debounced.trim() ? { query: debounced } : {})}`)
      .then(result => { if (!cancelled) { setEpisodes(result.episodes); setError(""); } })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to load episodes."); });
    return () => { cancelled = true; };
  }, [debounced]);
  async function open(id: number) {
    try { setSelected(await request<Episode>(`/api/knowledge/episode?id=${id}`)); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load the episode."); }
  }
  return <main className="control-page"><div className="page-intro"><p className="eyebrow">knowledge</p><h1>Episodes</h1>
    <p className="quiet">Things you have been pursuing across conversations, pages, and mail, assembled from your sources.</p></div>
    {error && <p role="alert" className="field-error">{error}</p>}
    <label className="settings-filter"><span className="sr-only">Search episodes</span>
      <input type="search" placeholder="Search episodes" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {selected ? <section className="control-card">
      <div className="card-heading"><div><p className="eyebrow">{selected.kind} · {span(selected)}</p><h2>{selected.title}</h2></div>
        <span className={selected.status === "active" ? "run-status running" : "run-status"}>{selected.status}</span></div>
      <button className="text-button" onClick={() => setSelected(null)}>Back to all episodes</button>
      {selected.summary && <p>{selected.summary}</p>}
      {selected.involves.length > 0 && <p className="quiet">Involves: {selected.involves.map(entity => `${entity.name} (${entity.type})`).join(", ")}</p>}
      <ol className="task-history">{selected.members.map(member => <li key={member.sourceId}>
        <strong>{day(member.at)}</strong> · {member.origin} · <em>{member.role}</em>{member.status !== "accepted" && " (unconfirmed)"}
        <div>{member.step || member.title}</div>
        <div className="quiet">{/^https?:/.test(member.uri) ? <a href={member.uri} target="_blank" rel="noreferrer">{member.title}</a> : member.title}</div>
        {member.summary && <div className="setting-description">{member.summary}</div>}
      </li>)}</ol>
    </section> : episodes === null ? <p className="quiet">Loading episodes…</p>
      : episodes.length === 0 ? <p className="quiet">No episodes yet. They appear as sources are digested.</p>
      : <div className="operations-grid">{episodes.map(episode => <section key={episode.id} className="control-card">
        <div className="card-heading"><div><p className="eyebrow">{episode.kind} · {span(episode)}</p><h2>{episode.title}</h2></div>
          <span className={episode.status === "active" ? "run-status running" : "run-status"}>{episode.status}</span></div>
        {episode.summary && <p className="quiet">{episode.summary}</p>}
        <p className="setting-description">{episode.members} source{episode.members === 1 ? "" : "s"} from {episode.origins.join(", ")}</p>
        <button className="action-button" onClick={() => open(episode.id)}>Open timeline</button>
      </section>)}</div>}
  </main>;
}
