import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  ChevronRight,
  CircleDot,
  Layers3,
  Network,
  Minus,
  Plus,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { getGraph, search } from "./api";
import type { GraphData, GraphNode, SearchMode, SearchResult } from "./types";

const TYPE_COLORS: Record<string, string> = {
  Note: "#8f4d35",
  Image: "#47786d",
  Vault: "#6a5a9b",
  WebPage: "#317b91",
  WebSession: "#76529d",
  Domain: "#aa7431",
  Topic: "#a54d69",
  BookmarkFolder: "#6d8339",
};

function colorFor(type: string) {
  return TYPE_COLORS[type] || "#68717a";
}

function shortText(text: string, length = 220) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > length ? `${clean.slice(0, length)}…` : clean;
}

function GraphMap({
  data,
  selected,
  visibleTypes,
  focusSelection,
  connectionDepth,
  onSelect,
}: {
  data: GraphData;
  selected: GraphNode | null;
  visibleTypes: Set<string>;
  focusSelection: boolean;
  connectionDepth: number;
  onSelect: (node: GraphNode) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragStart = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const visibleNodes = useMemo(() => {
    const typeFiltered = data.nodes.filter((node) => visibleTypes.has(node.type));
    if (!focusSelection || !selected) return typeFiltered;

    const adjacency = new Map<number, number[]>();
    for (const edge of data.edges) {
      adjacency.set(edge.source, [...(adjacency.get(edge.source) || []), edge.target]);
      adjacency.set(edge.target, [...(adjacency.get(edge.target) || []), edge.source]);
    }
    const included = new Set([selected.id]);
    let frontier = [selected.id];
    for (let degree = 0; degree < connectionDepth; degree++) {
      const next: number[] = [];
      for (const id of frontier) {
        for (const neighbor of adjacency.get(id) || []) {
          if (!included.has(neighbor)) {
            included.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }
    return data.nodes.filter((node) => included.has(node.id) && (node.id === selected.id || visibleTypes.has(node.type)));
  }, [connectionDepth, data.edges, data.nodes, focusSelection, selected, visibleTypes]);
  const layout = useMemo(() => {
    const cols = Math.max(6, Math.ceil(Math.sqrt(visibleNodes.length * 1.5)));
    return new Map(visibleNodes.map((node, index) => {
      const column = index % cols;
      const row = Math.floor(index / cols);
      const jitter = ((node.id * 37) % 19) - 9;
      return [node.id, { x: 58 + column * 86 + jitter, y: 54 + row * 66 + ((node.id * 17) % 13) }];
    }));
  }, [visibleNodes]);
  const width = Math.max(720, Math.ceil(Math.sqrt(visibleNodes.length * 1.5)) * 86 + 116);
  const height = Math.max(480, Math.ceil(visibleNodes.length / Math.max(6, Math.ceil(Math.sqrt(visibleNodes.length * 1.5)))) * 66 + 116);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));

  function pointFromEvent(event: { clientX: number; clientY: number }) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (event.clientX - rect.left) * (width / rect.width),
      y: (event.clientY - rect.top) * (height / rect.height),
    };
  }

  function zoomAtPoint(event: { clientX: number; clientY: number; deltaY: number }) {
    const point = pointFromEvent(event);
    const nextZoom = Math.min(4, Math.max(0.35, zoom * (event.deltaY < 0 ? 1.14 : 0.88)));
    const scale = nextZoom / zoom;
    setOffset({
      x: point.x - (point.x - offset.x) * scale,
      y: point.y - (point.y - offset.y) * scale,
    });
    setZoom(nextZoom);
  }

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAtPoint(event);
    };
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, [height, offset, width, zoom]);

  function startDrag(event: React.PointerEvent<SVGSVGElement>) {
    if ((event.target as Element).closest(".map-node")) return;
    const point = pointFromEvent(event);
    dragStart.current = { ...point, offsetX: offset.x, offsetY: offset.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function drag(event: React.PointerEvent<SVGSVGElement>) {
    if (!dragStart.current) return;
    const point = pointFromEvent(event);
    setOffset({
      x: dragStart.current.offsetX + point.x - dragStart.current.x,
      y: dragStart.current.offsetY + point.y - dragStart.current.y,
    });
  }

  function stopDrag() {
    dragStart.current = null;
  }

  return (
    <div className="map-scroll">
      <div className="map-controls" aria-label="Graph zoom controls">
        <button onClick={() => setZoom((current) => Math.min(4, current * 1.2))} aria-label="Zoom in"><Plus size={16} /></button>
        <button onClick={() => setZoom((current) => Math.max(0.35, current / 1.2))} aria-label="Zoom out"><Minus size={16} /></button>
        <button onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }} aria-label="Reset graph view"><RotateCcw size={14} /></button>
        <span>{Math.round(zoom * 100)}%</span>
      </div>
      <svg ref={svgRef} className={dragStart.current ? "graph-map dragging" : "graph-map"} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Knowledge graph map. Use the mouse wheel to zoom and drag empty space to pan." onPointerDown={startDrag} onPointerMove={drag} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
        <defs>
          <pattern id="paper-grid" width="22" height="22" patternUnits="userSpaceOnUse">
            <path d="M 22 0 L 0 0 0 22" fill="none" stroke="#d8d1c3" strokeWidth="0.5" opacity="0.55" />
          </pattern>
        </defs>
        <rect width={width} height={height} fill="url(#paper-grid)" />
        <g transform={`translate(${offset.x} ${offset.y}) scale(${zoom})`}>
        {data.edges.map((edge, index) => {
          if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target)) return null;
          const from = layout.get(edge.source);
          const to = layout.get(edge.target);
          if (!from || !to) return null;
          const highlighted = selected && (selected.id === edge.source || selected.id === edge.target);
          return <line key={`${edge.source}-${edge.target}-${edge.relation}-${index}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={highlighted ? "map-edge active" : "map-edge"} />;
        })}
        {visibleNodes.map((node) => {
          const point = layout.get(node.id)!;
          const isSelected = selected?.id === node.id;
          const radius = Math.min(13, 5 + Math.sqrt(node.degree || 1));
          return (
            <g key={node.id} className="map-node" onClick={() => onSelect(node)}>
              {isSelected && <circle cx={point.x} cy={point.y} r={radius + 5} fill="none" stroke={colorFor(node.type)} strokeWidth="1.5" opacity="0.75" />}
              <circle cx={point.x} cy={point.y} r={radius} fill={colorFor(node.type)} />
              {(isSelected || node.degree >= 8) && <text x={point.x + radius + 6} y={point.y + 4}>{shortText(node.name, 28)}</text>}
            </g>
          );
        })}
        </g>
      </svg>
    </div>
  );
}

function App() {
  const [data, setData] = useState<GraphData | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [visibleTypes, setVisibleTypes] = useState(new Set<string>());
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("hybrid");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusSelection, setFocusSelection] = useState(false);
  const [connectionDepth, setConnectionDepth] = useState(1);

  useEffect(() => {
    getGraph()
      .then((graph) => {
        setData(graph);
        setVisibleTypes(new Set(graph.nodes.map((node) => node.type)));
      })
      .catch((reason) => setError(reason.message));
  }, []);

  useEffect(() => {
    if (!selected) setFocusSelection(false);
  }, [selected]);

  const types = useMemo(() => data ? [...new Set(data.nodes.map((node) => node.type))].sort() : [], [data]);
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

  if (!data && !error) return <main className="loading-page">Opening the notebook…</main>;

  return (
    <main className="notebook-shell">
      <header className="masthead">
        <div className="wordmark"><span className="wordmark-mark">S</span><span>Shale</span></div>
        <div className="document-title"><span>knowledge notebook</span><small>{data?.stats.totalSources ?? 0} sources · {data?.stats.totalChunks ?? 0} passages</small></div>
        <div className="ledger"><span>{data?.stats.totalEntities ?? 0} entries</span><span>{data?.stats.totalEdges ?? 0} links</span></div>
      </header>

      <section className="workspace">
        <aside className="index-pane">
          <div className="pane-heading"><BookOpen size={16} /> <span>Index</span></div>
          <form className="search-form" onSubmit={runSearch}>
            <label htmlFor="knowledge-search">Search the notebook</label>
            <div className="search-box"><Search size={16} /><input id="knowledge-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="A concept, name, or question" /><button disabled={isSearching}>{isSearching ? "…" : "Find"}</button></div>
            <div className="search-modes">
              {(["hybrid", "bm25", "vector"] as SearchMode[]).map((item) => <button type="button" key={item} className={mode === item ? "mode active" : "mode"} onClick={() => setMode(item)}>{item === "bm25" ? "text" : item}</button>)}
            </div>
          </form>

          {results.length > 0 && <div className="result-list">
            <p className="section-label">Search notes</p>
            {results.map((result) => <button key={result.id} className="result-card" onClick={() => selectResult(result)}><strong>{result.source_title || "Untitled passage"}</strong><span>{shortText(result.preview || result.text_content, 118)}</span></button>)}
          </div>}

          <div className="filter-section">
            <p className="section-label">Show entries</p>
            <div className="filter-options">
              {types.map((type) => <label key={type} className="type-toggle"><input type="checkbox" checked={visibleTypes.has(type)} onChange={() => toggleType(type)} /><i style={{ backgroundColor: colorFor(type) }} /><span>{type}</span><small>{data?.nodes.filter((node) => node.type === type).length}</small></label>)}
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
          <div className="map-heading"><div><p className="eyebrow"><Network size={14} /> relationships</p><h1>Map of the collection</h1></div><span className="entry-count">{focusSelection && selected ? `${connectionDepth}-hop focus` : `${data?.nodes.filter((node) => visibleTypes.has(node.type)).length} visible`}</span></div>
          {error ? <div className="error-note">{error}</div> : data && <GraphMap data={data} selected={selected} visibleTypes={visibleTypes} focusSelection={focusSelection} connectionDepth={connectionDepth} onSelect={setSelected} />}
          <p className="map-caption">Each dot is an entry. Lines record a stated connection. Select an entry to read its material.</p>
        </section>

        <aside className="reading-pane">
          {selected ? <>
            <button className="close-reading" onClick={() => setSelected(null)} aria-label="Close reading pane"><X size={17} /></button>
            <p className="eyebrow"><CircleDot size={14} /> {selected.type}</p>
            <h2>{selected.name}</h2>
            <p className="source-line">{selected.namespace} · {selected.degree} recorded links</p>
            {selected.sourceUri && <a className="source-link" href={selected.sourceUri} target="_blank" rel="noreferrer">Open source <ChevronRight size={14} /></a>}
            <section className="reading-section"><p className="section-label">Connections</p>{connections.length ? connections.slice(0, 12).map(({ edge, node }) => <button key={`${edge.relation}-${node.id}`} className="connection" onClick={() => setSelected(node)}><span>{edge.relation.replaceAll("_", " ")}</span><strong>{node.name}</strong></button>) : <p className="quiet">No graph links recorded for this entry.</p>}</section>
            <section className="reading-section"><p className="section-label">Passages</p>{selected.chunks.length ? selected.chunks.map((chunk) => <article className="excerpt" key={chunk.id}><span>§ {chunk.chunk_index + 1}</span><p>{shortText(chunk.text_content, 700)}</p></article>) : <p className="quiet">No stored passage is attached to this entry.</p>}</section>
          </> : <div className="empty-reading"><Layers3 size={28} /><h2>Reading desk</h2><p>Select a dot, a connection, or a search result to open the underlying material here.</p></div>}
        </aside>
      </section>
    </main>
  );
}

export default App;
