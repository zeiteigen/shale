import { memo, useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Layers3,
  Network,
  Search,
} from "lucide-react";
import { getGraph, search } from "./api";
import type { GraphData, GraphNode, SearchMode, SearchResult } from "./types";
import { NodeReader } from './NodeReader';
import { searchPreview } from './search-preview';
import { GraphMap, colorFor } from './GraphMap';
import {useDebouncedValue} from './use-debounced-value';

function Notebook() {
  const [data, setData] = useState<GraphData | null>(null);
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
  const sourceResults = useMemo(() => {
    const bySource = new Map<string, SearchResult>();
    for (const result of results) if (!bySource.has(result.source_id)) bySource.set(result.source_id, result);
    return [...bySource.values()];
  }, [results]);
  const at=graphDate ? new Date(`${graphDate}T00:00:00Z`).getTime() : undefined;

  function refreshGraph() {
    getGraph({context:appliedContext || undefined,at},true).then(graph=> {
      setData(graph);setSelected(current=>current ? graph.nodes.find(n=>n.id===current.id) ?? null : null);
    }).catch(reason=>setError(reason.message));
  }

  useEffect(() => {
    let cancelled=false;
    getGraph({context:appliedContext || undefined,at})
      .then((graph) => {
        if (cancelled) return;
        setData(graph);
        setSelected(current => current ? graph.nodes.find(node => node.id === current.id) ?? null : null);
        setVisibleTypes(new Set(graph.nodes.map((node) => node.type)));
      })
      .catch((reason) => {if (!cancelled) setError(reason.message);});
    return ()=>{cancelled=true;};
  }, [appliedContext,graphDate]);

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
      .filter((item): item is { edge: GraphData["edges"][number]; node: GraphNode } => Boolean(item.node));
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
    if (node) setSelected(node);
  }

  return (
    <main className="notebook-shell">
      <header className="notebook-summary"><span>Knowledge notebook</span><span>{data?.stats.totalSources ?? 0} sources · {data?.stats.totalChunks ?? 0} passages · {data?.stats.totalEntities ?? 0} entries · {data?.stats.totalEdges ?? 0} links</span><button className="text-button" onClick={refreshGraph}>Refresh map</button></header>

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
          <div className="map-heading"><div><p className="eyebrow"><Network size={14} /> relationships</p><h1>Map of the collection</h1></div><span className="entry-count">{!data ? 'Loading graph…' : focusSelection && selected ? `${connectionDepth}-hop focus` : `${visibleCount} visible`}</span></div>
          {error ? <div className="error-note">{error}</div> : data ? <GraphMap data={data} selected={selected} visibleTypes={visibleTypes} focusSelection={focusSelection} connectionDepth={connectionDepth} onSelect={setSelected} /> : <div className="map-loading" role="status">Loading relationships… Search and navigation are available.</div>}
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
