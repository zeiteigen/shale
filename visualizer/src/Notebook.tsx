import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Layers3,
  Network,
  Search,
  RefreshCw,
} from "lucide-react";
import { search } from "./api";
import type { GraphNode, SearchMode, SearchResult } from "./types";
import { useLiveGraph } from "./use-live-graph";
import { searchGraphNodes } from "./graph-node-search";
import { NodeReader } from './NodeReader';
import { searchPreview } from './search-preview';
import { GraphMap, colorFor } from './GraphMap';
import {useDebouncedValue} from './use-debounced-value';
import { OrganicGraphMap } from './OrganicGraphMap';
import { GraphForces } from './GraphForces';
import { readGraphPreferences, saveGraphPreferences } from './graph-preferences';
import { createOrganicSession } from './use-force-layout';
import './graph-view.css';

function Notebook() {
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [visibleTypes, setVisibleTypes] = useState(new Set<string>());
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("bm25");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusSelection, setFocusSelection] = useState(false);
  const [connectionDepth, setConnectionDepth] = useState(1);
  const [graphContext,setGraphContext]=useState('');
  const appliedContext=useDebouncedValue(graphContext);
  const [graphDate,setGraphDate]=useState('');
  const [graphPreferences, setGraphPreferences] = useState(readGraphPreferences);
  const [organicSession] = useState(createOrganicSession);
  const knownTypes = useRef(new Set<string>());
  const classicCamera = useRef({ width: 1, height: 1, zoom: 1, x: 0, y: 0 });
  useEffect(() => { saveGraphPreferences(graphPreferences); }, [graphPreferences]);
  const sourceResults = useMemo(() => {
    const bySource = new Map<string, SearchResult>();
    for (const result of results) if (!bySource.has(result.source_id)) bySource.set(result.source_id, result);
    return [...bySource.values()];
  }, [results]);
  const at=graphDate ? new Date(`${graphDate}T00:00:00Z`).getTime() : undefined;
  const { data, error: graphError, refresh: refreshGraph } = useLiveGraph(appliedContext || undefined, at);
  const displayError = error || graphError;
  const entityResults = useMemo(() => searchGraphNodes(data?.nodes ?? [], query), [data, query]);
  useEffect(() => {
    if (!data) return;
    const types = new Set(data.nodes.map(node => node.type));
    const added = [...types].filter(type => !knownTypes.current.has(type));
    knownTypes.current = new Set([...knownTypes.current, ...types]);
    setVisibleTypes(current => new Set([...current, ...added]));
    setSelected(current => current ? data.nodes.find(node => node.id === current.id) ?? null : null);
  }, [data]);

  useEffect(() => {
    if (!selected) setFocusSelection(false);
  }, [selected]);

  const types = useMemo(() => data ? [...new Set(data.nodes.map((node) => node.type))].sort() : [], [data]);
  const typeCounts=useMemo(()=>{const counts=new Map<string,number>();for(const node of data?.nodes ?? [])counts.set(node.type,(counts.get(node.type) ?? 0)+1);return counts;},[data]);
  const visibleCount=useMemo(()=>data?.nodes.reduce((count,node)=>count+Number(visibleTypes.has(node.type)),0) ?? 0,[data,visibleTypes]);
  const connections = useMemo(() => {
    if (!data || !selected) return [];
    const byId = new Map(data.nodes.map((node) => [node.id, node]));
    return data.edges
      .filter((edge) => edge.source === selected.id || edge.target === selected.id)
      .map((edge) => ({ edge, node: byId.get(edge.source === selected.id ? edge.target : edge.source) }))
      .filter((item): item is { edge: typeof data.edges[number]; node: GraphNode } => Boolean(item.node));
  }, [data, selected]);

  function toggleType(type: string) {
    setVisibleTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setIsSearching(true);
    setError(null);
    try {
      const response = await search(query.trim(), mode);
      setResults(response.results);
    } catch (reason: any) {
      setError(reason.message);
    } finally {
      setIsSearching(false);
    }
  }

  function selectResult(result: SearchResult) {
    const node = data?.nodes.find((item) => item.id === result.entity_id)
      || data?.nodes.find((item) => item.sourceUri === result.source_uri)
      || data?.nodes.find((item) => item.name === result.source_title);
    if (node) selectNode(node);
  }

  function selectNode(node: GraphNode) {
    setVisibleTypes(current => new Set([...current, node.type]));
    setSelected(node);
  }

  return (
    <main className="notebook-shell">
      <header className="notebook-summary"><span>Knowledge notebook</span><span>{data?.stats.totalSources ?? 0} sources · {data?.stats.totalChunks ?? 0} passages · {data?.stats.totalEntities ?? 0} entries · {data?.stats.totalEdges ?? 0} links</span><button className="text-button" onClick={refreshGraph}><RefreshCw size={14} /> Refresh map</button></header>

      <section className={`workspace${selected ? ' has-selection' : ''}`}>
        <aside className="index-pane">
          <div className="pane-heading"><BookOpen size={16} /> <span>Index</span></div>
          <form className="search-form" onSubmit={runSearch}>
            <label htmlFor="knowledge-search">Search the notebook</label>
            <div className="search-box"><Search size={16} /><input id="knowledge-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="A concept, name, or question" /><button disabled={isSearching}>{isSearching ? "…" : "Find"}</button></div>
            <div className="search-modes">
              {(["bm25"] as SearchMode[]).map((item) => <button type="button" key={item} className={mode === item ? "mode active" : "mode"} onClick={() => setMode(item)}>{item === "bm25" ? "text" : item}</button>)}
            </div>
          </form>

          {entityResults.length > 0 && <div className="result-list" aria-label="Matching graph entries">
            <p className="section-label">Graph entries</p>
            {entityResults.map(node => <button key={node.id} className="result-card" onClick={() => selectNode(node)}><strong>{node.name}</strong><span>{node.type} · {node.namespace}</span></button>)}
          </div>}

          {results.length > 0 && <div className="result-list">
            <p className="section-label">Search notes</p>
            {sourceResults.map((result) => <button key={result.source_id} className="result-card" onClick={() => selectResult(result)}><strong>{result.source_title || "Untitled source"}</strong><span>{searchPreview(result.preview || result.text_content)}</span></button>)}
          </div>}

          <div className="filter-section">
            <div className="knowledge-panel">
              <label>Context<input value={graphContext} onChange={e=>setGraphContext(e.target.value)} placeholder="All contexts" /></label>
              <label>Valid on<input type="date" value={graphDate} onChange={e=>setGraphDate(e.target.value)} /></label>
              {data?.truncated && <p className="quiet">Showing the first 10,000 relationships. Filter the context to narrow the map.</p>}
            </div>
            <p className="section-label">Show entries</p>
            <div className="filter-options">
              {types.map((type) => <label key={type} className="type-toggle"><input type="checkbox" checked={visibleTypes.has(type)} onChange={() => toggleType(type)} /><i style={{ backgroundColor: colorFor(type) }} /><span title={type}>{type}</span><small>{typeCounts.get(type)}</small></label>)}
            </div>
            <div className="selection-filter">
              <label><input type="checkbox" checked={focusSelection} disabled={!selected} onChange={(event) => setFocusSelection(event.target.checked)} /> Focus selection</label>
              <select aria-label="Connection depth" value={connectionDepth} disabled={!focusSelection || !selected} onChange={(event) => setConnectionDepth(Number(event.target.value))}>
                <option value={1}>1 hop</option>
                <option value={2}>2 hops</option>
                <option value={3}>3 hops</option>
              </select>
              {!selected && <small>Select an entry to focus its connections.</small>}
            </div>
          </div>
        </aside>

        <section className="map-pane">
          <div className="map-heading"><div><p className="eyebrow"><Network size={14} /> relationships</p><h1>Map of the collection</h1></div><div className="map-heading-actions"><span className="entry-count">{!data ? 'Loading graph…' : focusSelection && selected ? `${connectionDepth}-hop focus` : `${visibleCount} visible`}</span><div className="graph-mode-toggle" role="group" aria-label="Graph view">
            {(['organic', 'classic'] as const).map(view => <button key={view} type="button" aria-pressed={graphPreferences.mode === view} onClick={() => setGraphPreferences(current => ({ ...current, mode: view }))}>{view === 'organic' ? 'Organic' : 'Classic'}</button>)}
          </div></div></div>
          {displayError ? <div className="error-note">{displayError}</div> : data ? graphPreferences.mode === 'classic'
            ? <GraphMap data={data} selected={selected} visibleTypes={visibleTypes} focusSelection={focusSelection} connectionDepth={connectionDepth} onSelect={setSelected} viewState={classicCamera.current} />
            : <OrganicGraphMap data={data} selected={selected} visibleTypes={visibleTypes} focusSelection={focusSelection} connectionDepth={connectionDepth} onSelect={setSelected} forces={graphPreferences.forces} session={organicSession} />
            : <div className="map-loading" role="status">Loading relationships… Search and navigation are available.</div>}
          {graphPreferences.mode === 'organic' && <GraphForces value={graphPreferences.forces} onChange={forces => setGraphPreferences(current => ({ ...current, forces }))} />}
          <p className="map-caption">Each dot is an entry. Select one to read its summary and snippets. Dashed connections await review or are disputed.</p>
        </section>

        <aside className="reading-pane" aria-label="Entry reader">
          {selected ? <NodeReader key={selected.id} node={selected} nodes={data?.nodes ?? []} connections={connections} onSelect={setSelected} onClose={() => setSelected(null)} onChanged={refreshGraph} onFocus={() => setFocusSelection(true)} context={appliedContext || undefined} at={at} /> : <div className="empty-reading"><Layers3 size={28} /><h2>Reading desk</h2><p>Select a dot, a connection, or a search result to read its summary, snippets, and evidence.</p></div>}
        </aside>
      </section>
    </main>
  );
}

export default memo(Notebook);
