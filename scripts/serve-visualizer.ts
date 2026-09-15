// Compatibility entrypoint. The visualizer now lives in ../visualizer.
export { getGraphData, startVisualizerServer, type GraphData } from "../visualizer/server";
import { startVisualizerServer } from "../visualizer/server";

if (import.meta.main) {
  startVisualizerServer();
}

/*
import { createExtensionSDK, type ChunkSearchResult } from "../sdk";

const sdk = createExtensionSDK("visualizer");
const db = sdk.database;

export interface GraphData {
  nodes: Array<{
    id: number;
    name: string;
    type: string;
    namespace: string;
    degree: number;
    sourceUri?: string;
    sourceTitle?: string;
    chunksCount?: number;
    chunks?: Array<{ id: number; chunk_index: number; text_content: string }>;
  }>;
  edges: Array<{
    source: number;
    target: number;
    relation: string;
    weight: number;
  }>;
  stats: {
    totalEntities: number;
    totalEdges: number;
    totalSources: number;
    totalChunks: number;
    noteCount: number;
    imageCount: number;
    vaultCount: number;
  };
}

export function getGraphData(): GraphData {
  const entities = db
    .query<
      { id: number; namespace: string; name: string; type: string },
      []
    >("SELECT id, namespace, name, type FROM entities ORDER BY id ASC")
    .all();

  const edges = db
    .query<
      {
        source_entity_id: number;
        target_entity_id: number;
        relation: string;
        weight: number;
      },
      []
    >("SELECT source_entity_id, target_entity_id, relation, weight FROM edges")
    .all();

  const sources = db
    .query<
      { id: string; type: string; uri: string; title: string },
      []
    >("SELECT id, type, uri, title FROM sources")
    .all();

  const sourceMapByTitle = new Map<string, (typeof sources)[0]>();
  for (const s of sources) {
    sourceMapByTitle.set(s.title.toLowerCase(), s);
  }

  // Calculate degrees
  const degreeMap = new Map<number, number>();
  for (const edge of edges) {
    degreeMap.set(
      edge.source_entity_id,
      (degreeMap.get(edge.source_entity_id) || 0) + 1,
    );
    degreeMap.set(
      edge.target_entity_id,
      (degreeMap.get(edge.target_entity_id) || 0) + 1,
    );
  }

  const nodes = entities.map((ent) => {
    const matchedSource = sourceMapByTitle.get(ent.name.toLowerCase());
    let chunks: Array<{
      id: number;
      chunk_index: number;
      text_content: string;
    }> = [];
    if (matchedSource) {
      chunks = sdk.context.getRecentChunks(matchedSource.id, 5);
    }

    return {
      id: ent.id,
      name: ent.name,
      type: ent.type,
      namespace: ent.namespace,
      degree: degreeMap.get(ent.id) || 0,
      sourceUri: matchedSource?.uri,
      sourceTitle: matchedSource?.title,
      chunksCount: chunks.length,
      chunks: chunks.map((c) => ({
        id: c.id,
        chunk_index: c.chunk_index,
        text_content: c.text_content,
      })),
    };
  });

  const totalSources =
    db.query<{ c: number }>("SELECT count(*) as c FROM sources").get()?.c || 0;
  const totalChunks =
    db.query<{ c: number }>("SELECT count(*) as c FROM chunks").get()?.c || 0;

  return {
    nodes,
    edges: edges.map((e) => ({
      source: e.source_entity_id,
      target: e.target_entity_id,
      relation: e.relation,
      weight: e.weight,
    })),
    stats: {
      totalEntities: entities.length,
      totalEdges: edges.length,
      totalSources,
      totalChunks,
      noteCount: entities.filter((e) => e.type === "Note").length,
      imageCount: entities.filter((e) => e.type === "Image").length,
      vaultCount: entities.filter((e) => e.type === "Vault").length,
    },
  };
}

export function buildVisualizerHtml(embeddedData?: GraphData): string {
  const dataJson = embeddedData ? JSON.stringify(embeddedData) : "null";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Shale Knowledge Graph & Search Visualizer</title>
  <script src="https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js"></script>
  <style>
    :root {
      --bg: #090d16;
      --card: #111827;
      --border: #1f293d;
      --text: #f3f4f6;
      --muted: #9ca3af;
      --accent: #3b82f6;
    }
    body {
      background-color: var(--bg);
      color: var(--text);
      overflow: hidden;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    .badge-vault { background: rgba(139, 92, 246, 0.2); color: #c084fc; border: 1px solid rgba(139, 92, 246, 0.4); }
    .badge-note { background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4); }
    .badge-image { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
    .custom-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
    .custom-scroll::-webkit-scrollbar-thumb { background: #374151; border-radius: 3px; }
    .custom-scroll::-webkit-scrollbar-track { background: transparent; }
    mark { background-color: rgba(234, 179, 8, 0.35); color: #fef08a; padding: 0 2px; border-radius: 2px; }
    @keyframes pulse-ring {
      0% { transform: scale(0.95); opacity: 0.8; }
      50% { transform: scale(1.3); opacity: 0.2; }
      100% { transform: scale(0.95); opacity: 0.8; }
    }
  </style>
</head>
<body class="h-screen w-screen flex flex-col antialiased select-none">
  <!-- Top Navbar -->
  <header class="h-14 border-b border-[var(--border)] bg-[var(--card)] px-4 flex items-center justify-between z-10 shrink-0">
    <div class="flex items-center space-x-3">
      <div class="w-8 h-8 rounded-lg bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center font-bold text-white shadow-md">
        S
      </div>
      <div>
        <h1 class="text-sm font-semibold tracking-wide text-white flex items-center space-x-2">
          <span>Shale Graph & Vector Search</span>
          <span class="text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">Vector + BM25</span>
        </h1>
        <p class="text-[11px] text-[var(--muted)]">Qwen3-VL Multimodal Embeddings (4096-d) & FTS5 Lexical Search</p>
      </div>
    </div>

    <!-- Quick Stats Bar -->
    <div class="hidden lg:flex items-center space-x-3 text-xs">
      <div class="flex items-center space-x-1.5 bg-slate-800/80 px-2.5 py-1 rounded-md border border-slate-700/60">
        <span class="w-2 h-2 rounded-full bg-purple-400"></span>
        <span class="text-slate-400">Vaults:</span>
        <span id="stat-vaults" class="font-semibold text-white">0</span>
      </div>
      <div class="flex items-center space-x-1.5 bg-slate-800/80 px-2.5 py-1 rounded-md border border-slate-700/60">
        <span class="w-2 h-2 rounded-full bg-blue-400"></span>
        <span class="text-slate-400">Notes:</span>
        <span id="stat-notes" class="font-semibold text-white">0</span>
      </div>
      <div class="flex items-center space-x-1.5 bg-slate-800/80 px-2.5 py-1 rounded-md border border-slate-700/60">
        <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
        <span class="text-slate-400">Images:</span>
        <span id="stat-images" class="font-semibold text-white">0</span>
      </div>
      <div class="flex items-center space-x-1.5 bg-slate-800/80 px-2.5 py-1 rounded-md border border-slate-700/60">
        <span class="text-slate-400">Edges:</span>
        <span id="stat-edges" class="font-semibold text-white">0</span>
      </div>
      <div class="flex items-center space-x-1.5 bg-slate-800/80 px-2.5 py-1 rounded-md border border-slate-700/60">
        <span class="text-slate-400">Chunks:</span>
        <span id="stat-chunks" class="font-semibold text-white">0</span>
      </div>
    </div>

    <!-- Actions & Controls -->
    <div class="flex items-center space-x-2">
      <button id="btn-recenter" class="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 transition">
        Reset View
      </button>
      <button id="btn-toggle-physics" class="px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded shadow transition">
        Pause Physics
      </button>
    </div>
  </header>

  <!-- Main Container -->
  <div class="flex-1 flex relative overflow-hidden">
    <!-- Left Navigation / Control Drawer (Tabs: Search vs Filters) -->
    <div class="absolute top-4 left-4 z-20 w-80 max-h-[calc(100vh-5rem)] bg-[var(--card)]/95 backdrop-blur-md border border-[var(--border)] rounded-xl shadow-2xl flex flex-col overflow-hidden">
      <!-- Tabs Header -->
      <div class="grid grid-cols-2 p-1.5 bg-slate-900/90 border-b border-slate-800 gap-1 text-xs">
        <button id="tab-btn-search" class="py-1.5 px-2 rounded-lg font-medium text-white bg-blue-600 shadow transition flex items-center justify-center space-x-1.5">
          <span>🔍 Vector & BM25</span>
        </button>
        <button id="tab-btn-filters" class="py-1.5 px-2 rounded-lg font-medium text-slate-400 hover:text-slate-200 transition flex items-center justify-center space-x-1.5">
          <span>🗂️ Filters</span>
        </button>
      </div>

      <!-- Tab Content 1: Vector & BM25 Search -->
      <div id="tab-content-search" class="flex-1 flex flex-col overflow-hidden p-3.5 space-y-3">
        <!-- Search Input -->
        <div>
          <label class="text-[11px] font-semibold text-slate-300 block mb-1">SEARCH KNOWLEDGE BASE</label>
          <div class="relative">
            <input id="search-query" type="text" placeholder="e.g. state sovereignty, alcohols, RNN..." 
              class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition">
          </div>
        </div>

        <!-- Search Mode Radio / Buttons -->
        <div>
          <label class="text-[10px] font-semibold text-slate-400 block mb-1">SEARCH MODE</label>
          <div class="grid grid-cols-3 gap-1 text-xs">
            <button class="mode-btn py-1 px-1.5 rounded text-[11px] font-medium border border-blue-500 bg-blue-500/20 text-blue-300" data-mode="hybrid">
              ⚡ Hybrid
            </button>
            <button class="mode-btn py-1 px-1.5 rounded text-[11px] font-medium border border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-700" data-mode="vector">
              🧬 Vector
            </button>
            <button class="mode-btn py-1 px-1.5 rounded text-[11px] font-medium border border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-700" data-mode="bm25">
              📖 BM25
            </button>
          </div>
        </div>

        <!-- Search Controls Bar -->
        <div class="flex items-center justify-between space-x-2">
          <div class="flex items-center space-x-1 text-[11px] text-slate-400">
            <span>Top:</span>
            <select id="search-limit" class="bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-200">
              <option value="5">5</option>
              <option value="10" selected>10</option>
              <option value="20">20</option>
            </select>
          </div>
          <div class="flex space-x-1.5">
            <button id="btn-clear-search" class="px-2.5 py-1 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition hidden">
              Clear
            </button>
            <button id="btn-run-search" class="px-3.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white font-medium rounded shadow transition flex items-center space-x-1.5">
              <span id="search-spinner" class="hidden animate-spin">⌛</span>
              <span id="search-btn-text">Search</span>
            </button>
          </div>
        </div>

        <!-- Results List Section -->
        <div class="flex-1 flex flex-col min-h-0 border-t border-slate-800/80 pt-2">
          <div class="flex items-center justify-between text-[10px] text-slate-400 mb-1.5">
            <span id="search-status">Ready to search</span>
            <span id="search-match-count" class="font-mono text-blue-400"></span>
          </div>

          <div id="search-results-list" class="flex-1 overflow-y-auto space-y-2 pr-1 custom-scroll max-h-72">
            <!-- Results populated dynamically -->
            <div class="text-center py-8 text-slate-500 text-xs">
              Type a concept or question above and click Search.
            </div>
          </div>
        </div>
      </div>

      <!-- Tab Content 2: Graph Filters -->
      <div id="tab-content-filters" class="hidden flex-1 overflow-y-auto p-3.5 space-y-3 custom-scroll">
        <!-- Node Type Filters -->
        <div>
          <label class="text-[11px] font-semibold text-slate-400 block mb-1.5">NODE TYPES</label>
          <div id="node-type-filters" class="grid grid-cols-2 gap-1.5 text-xs"></div>
        </div>

        <!-- Relationship Filters -->
        <div>
          <label class="text-[11px] font-semibold text-slate-400 block mb-1.5">RELATIONSHIPS</label>
          <div id="relationship-filters" class="space-y-1 text-xs"></div>
        </div>

        <!-- Title Filter -->
        <div>
          <label class="text-[11px] font-semibold text-slate-400 block mb-1">QUICK TITLE FILTER</label>
          <input id="filter-title-input" type="text" placeholder="Filter title text in graph..." 
            class="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition">
        </div>

        <!-- Hint -->
        <div class="text-[10px] text-slate-500 border-t border-slate-800/80 pt-2 flex items-center justify-between">
          <span>Scroll to Zoom • Drag to Pan</span>
          <span id="visible-count">0 nodes visible</span>
        </div>
      </div>
    </div>

    <!-- Canvas Graph View -->
    <div class="flex-1 h-full w-full relative">
      <canvas id="graph-canvas" class="w-full h-full block cursor-grab active:cursor-grabbing"></canvas>
      
      <!-- Canvas Zoom Floating Controls -->
      <div class="absolute bottom-4 left-4 z-20 flex flex-col space-y-1 bg-slate-900/90 border border-slate-800 rounded-lg p-1 shadow-lg">
        <button id="btn-zoom-in" class="w-7 h-7 flex items-center justify-center text-slate-300 hover:text-white hover:bg-slate-800 rounded text-sm font-bold">+</button>
        <button id="btn-zoom-out" class="w-7 h-7 flex items-center justify-center text-slate-300 hover:text-white hover:bg-slate-800 rounded text-sm font-bold">-</button>
      </div>

      <!-- Hover Tooltip -->
      <div id="node-tooltip" class="absolute pointer-events-none hidden z-30 bg-slate-900/95 border border-slate-700 text-white text-xs px-2.5 py-1.5 rounded-md shadow-2xl backdrop-blur-sm">
        <div id="tooltip-title" class="font-semibold text-slate-100"></div>
        <div id="tooltip-meta" class="text-[10px] text-slate-400 mt-0.5"></div>
      </div>
    </div>

    <!-- Right-Hand Inspector Drawer Panel -->
    <div id="inspector-panel" class="w-96 border-l border-[var(--border)] bg-[var(--card)] flex flex-col z-20 transition-all duration-300 transform translate-x-full md:translate-x-0 shrink-0">
      <div class="p-4 border-b border-[var(--border)] flex items-center justify-between bg-slate-900/50">
        <div>
          <h2 class="text-xs font-semibold text-slate-300 tracking-wider">NODE & CHUNK INSPECTOR</h2>
          <p class="text-[11px] text-slate-500">Metadata, Provenance & Vector Embeddings</p>
        </div>
        <button id="close-inspector" class="text-slate-400 hover:text-white text-sm p-1 md:hidden">&times;</button>
      </div>

      <div id="inspector-content" class="flex-1 overflow-y-auto p-4 space-y-4 custom-scroll">
        <!-- Empty State -->
        <div id="inspector-empty" class="text-center py-16 text-slate-500">
          <div class="w-12 h-12 mx-auto mb-3 rounded-full bg-slate-800/80 flex items-center justify-center text-slate-400 text-xl">
            🔍
          </div>
          <p class="text-xs font-medium text-slate-400">Click a node or search result</p>
          <p class="text-[11px] text-slate-600 mt-1 max-w-[220px] mx-auto">Inspect dynamic note chunks, relationships, or image asset embeddings.</p>
        </div>

        <!-- Populated State -->
        <div id="inspector-details" class="hidden space-y-4">
          <!-- Title & Badges -->
          <div>
            <div class="flex items-center space-x-2 mb-1.5">
              <span id="detail-type-badge" class="px-2 py-0.5 rounded text-[10px] font-semibold tracking-wider uppercase"></span>
              <span id="detail-namespace" class="text-[10px] text-slate-400 font-mono"></span>
            </div>
            <h3 id="detail-title" class="text-base font-bold text-white leading-tight break-words"></h3>
            <p id="detail-uri" class="text-[10px] text-slate-400 font-mono mt-1 break-all bg-slate-900/60 p-1.5 rounded border border-slate-800/80"></p>
            <!-- Source External Open Actions -->
            <div id="source-actions-bar" class="flex items-center gap-1.5 mt-2 pt-1.5 border-t border-slate-800/80 flex-wrap">
              <button id="btn-open-system" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-medium border border-slate-700 flex items-center space-x-1 transition cursor-pointer" title="Open file in default system application (xdg-open)">
                <span>↗ Open File</span>
              </button>
              <button id="btn-open-obsidian" class="px-2 py-1 rounded bg-purple-950/80 hover:bg-purple-900 text-purple-300 text-[11px] font-medium border border-purple-800/60 flex items-center space-x-1 transition cursor-pointer" title="Open directly in Obsidian app">
                <span>💜 Open in Obsidian</span>
              </button>
              <a id="link-open-browser" href="#" target="_blank" class="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 text-[11px] font-medium border border-slate-800 flex items-center space-x-1 transition" title="Open raw file in a new browser tab">
                <span>🌐 Browser</span>
              </a>
              <button id="btn-copy-path" class="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 text-[11px] font-mono border border-slate-800 transition cursor-pointer" title="Copy full filesystem path">
                <span>📋 Copy Path</span>
              </button>
              <span id="open-action-feedback" class="text-[10px] text-emerald-400 font-mono ml-auto hidden">Opened!</span>
            </div>
          </div>

          <!-- Quick Stats Grid -->
          <div class="grid grid-cols-2 gap-2 text-xs">
            <div class="bg-slate-900/70 p-2.5 rounded-lg border border-slate-800">
              <span class="text-slate-400 text-[10px] block">Degree (Connections)</span>
              <span id="detail-degree" class="text-sm font-bold text-blue-400">0</span>
            </div>
            <div class="bg-slate-900/70 p-2.5 rounded-lg border border-slate-800">
              <span class="text-slate-400 text-[10px] block">Chunks Count</span>
              <span id="detail-chunks-count" class="text-sm font-bold text-emerald-400">0</span>
            </div>
          </div>

          <!-- Semantic Nearest Neighbors (KNN) -->
          <div id="knn-section" class="p-3 rounded-lg bg-slate-900/90 border border-slate-800 space-y-2.5">
            <div class="flex items-center justify-between">
              <div class="flex items-center space-x-1.5">
                <span class="text-xs">🧭</span>
                <h4 class="text-[11px] font-bold text-slate-300 uppercase tracking-wider">Nearest Neighbors</h4>
              </div>
              <span class="text-[9px] px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-400 font-mono border border-cyan-800/60">Vector KNN</span>
            </div>

            <div class="flex items-center space-x-2">
              <label class="text-[11px] text-slate-400 shrink-0 font-medium">K neighbors:</label>
              <input type="number" id="knn-k-input" min="1" max="25" value="5" class="w-14 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-white text-center font-mono focus:outline-none focus:border-cyan-500">
              <button id="btn-find-knn" class="flex-1 bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold py-1 px-2.5 rounded transition shadow flex items-center justify-center space-x-1 cursor-pointer">
                <span>Find Neighbors</span>
              </button>
              <button id="btn-clear-knn" class="hidden text-slate-400 hover:text-white text-xs py-1 px-2 rounded bg-slate-800 hover:bg-slate-700 transition cursor-pointer" title="Clear KNN overlay">
                &times;
              </button>
            </div>

            <!-- KNN Results List -->
            <div id="knn-results-container" class="hidden space-y-2 pt-1 border-t border-slate-800/80">
              <div class="flex items-center justify-between text-[10px] text-slate-400">
                <span id="knn-status-text">Top neighbors</span>
                <span id="knn-active-count" class="font-mono text-cyan-400"></span>
              </div>
              <div id="knn-results-list" class="space-y-1.5 max-h-56 overflow-y-auto custom-scroll pr-1 text-xs">
                <!-- Dynamically populated -->
              </div>
            </div>
          </div>

          <!-- Connected Entities -->
          <div>
            <h4 class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Connected Relationships</h4>
            <div id="detail-connections-list" class="space-y-1.5 text-xs max-h-40 overflow-y-auto custom-scroll pr-1">
              <!-- Dynamically populated -->
            </div>
          </div>

          <!-- Chunks / Content Preview -->
          <div>
            <h4 class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Ingested Chunks & Text</h4>
            <div id="detail-chunks-list" class="space-y-2 text-xs">
              <!-- Dynamically populated -->
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    // Embedded Data or Live Fetch
    const EMBEDDED_DATA = ${dataJson};

    // State
    let graphData = { nodes: [], edges: [], stats: {} };
    let filteredNodes = [];
    let filteredEdges = [];
    let selectedNode = null;
    let hoveredNode = null;
    let physicsRunning = true;

    // Search state
    let searchMode = "hybrid";
    let searchResults = []; // [{ entityId, rank, score, sourceTitle, ... }]
    let searchResultMap = new Map(); // entityId -> result

    // KNN State
    let activeKnn = null; // { sourceNode, k, neighbors, neighborMap }

    // Simulation params
    const sim = {
      alpha: 1.0,
      alphaMin: 0.001,
      alphaDecay: 0.015,
      friction: 0.85,
      repulsion: 1800,
      springLength: 70,
      springStrength: 0.04,
      centering: 0.02
    };

    // Camera transform
    const camera = { x: 0, y: 0, scale: 1.0 };
    let isDraggingCanvas = false;
    let dragStart = { x: 0, y: 0 };
    let draggedNode = null;

    const canvas = document.getElementById("graph-canvas");
    const ctx = canvas.getContext("2d");

    // Colors
    const TYPE_COLORS = {
      "Vault": { bg: "#8b5cf6", border: "#c084fc", text: "#ede9fe", radius: 22 },
      "Note": { bg: "#2563eb", border: "#60a5fa", text: "#eff6ff", radius: 9 },
      "Image": { bg: "#059669", border: "#34d399", text: "#ecfdf5", radius: 12 },
      "WebPage": { bg: "#0891b2", border: "#22d3ee", text: "#ecfeff", radius: 10 },
      "WebSession": { bg: "#7c3aed", border: "#c4b5fd", text: "#f5f3ff", radius: 16 },
      "Domain": { bg: "#b45309", border: "#fbbf24", text: "#fffbeb", radius: 9 },
      "Topic": { bg: "#be185d", border: "#f9a8d4", text: "#fdf2f8", radius: 10 },
      "BookmarkFolder": { bg: "#4d7c0f", border: "#a3e635", text: "#f7fee7", radius: 11 },
      "Generic": { bg: "#475569", border: "#94a3b8", text: "#f8fafc", radius: 10 }
    };

    const EDGE_COLORS = {
      "REFERENCES": "rgba(56, 189, 248, 0.75)",
      "FEATURES_IMAGE": "rgba(52, 211, 153, 0.85)",
      "IN_SAME_VAULT": "rgba(147, 51, 234, 0.18)",
      "BELONGS_TO_DOMAIN": "rgba(34, 211, 238, 0.7)",
      "HAS_TOPIC": "rgba(244, 114, 182, 0.7)",
      "CONTAINS_PAGE": "rgba(196, 181, 253, 0.75)",
      "COVERS_TOPIC": "rgba(249, 168, 212, 0.7)",
      "PRIMARY_DOMAIN": "rgba(251, 191, 36, 0.7)",
      "NAVIGATED_TO": "rgba(148, 163, 184, 0.65)",
      "BOOKMARKED_IN": "rgba(163, 230, 53, 0.7)"
    };

    function nodeStyle(type) {
      return TYPE_COLORS[type] || TYPE_COLORS.Generic;
    }

    function resizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.resetTransform();
      ctx.scale(dpr, dpr);
      render();
    }

    async function initData() {
      if (EMBEDDED_DATA) {
        graphData = EMBEDDED_DATA;
      } else {
        try {
          const res = await fetch("/api/graph");
          if (res.ok) {
            graphData = await res.json();
          }
        } catch (err) {
          console.error("Failed to fetch /api/graph:", err);
        }
      }

      populateFilters();
      updateStatsUI();
      initializeNodePositions();
      applyFilters();
      recenterView();
      requestAnimationFrame(simLoop);
    }

    function populateFilters() {
      const nodeTypes = [...new Set(graphData.nodes.map(n => n.type))].sort();
      const relations = [...new Set(graphData.edges.map(e => e.relation))].sort();
      const nodeContainer = document.getElementById("node-type-filters");
      const relationshipContainer = document.getElementById("relationship-filters");

      nodeContainer.innerHTML = nodeTypes.map(type =>
        \`<label class="flex items-center space-x-1.5 bg-slate-900/80 px-2 py-1.5 rounded border border-slate-800 cursor-pointer hover:border-slate-700">
          <input type="checkbox" data-node-type="\${escapeHtml(type)}" checked class="accent-blue-500 rounded">
          <span class="text-slate-300 text-[11px] truncate" title="\${escapeHtml(type)}">\${escapeHtml(type)}</span>
        </label>\`
      ).join("") || '<span class="text-[11px] text-slate-500">No node types yet.</span>';

      relationshipContainer.innerHTML = relations.map(relation =>
        \`<label class="flex items-center justify-between gap-2 bg-slate-900/80 px-2.5 py-1.5 rounded border border-slate-800 cursor-pointer hover:border-slate-700">
          <span class="flex items-center space-x-2 min-w-0">
            <span class="w-3 h-0.5 bg-cyan-400 inline-block shrink-0"></span>
            <span class="text-slate-300 text-[11px] truncate" title="\${escapeHtml(relation)}">\${escapeHtml(relation)}</span>
          </span>
          <input type="checkbox" data-relation="\${escapeHtml(relation)}" checked class="accent-cyan-500 rounded shrink-0">
        </label>\`
      ).join("") || '<span class="text-[11px] text-slate-500">No relationships yet.</span>';

      document.querySelectorAll("[data-node-type], [data-relation]").forEach(input => {
        input.addEventListener("change", applyFilters);
      });
    }

    function updateStatsUI() {
      const s = graphData.stats || {};
      document.getElementById("stat-vaults").innerText = s.vaultCount || 0;
      document.getElementById("stat-notes").innerText = s.noteCount || 0;
      document.getElementById("stat-images").innerText = s.imageCount || 0;
      document.getElementById("stat-edges").innerText = s.totalEdges || 0;
      document.getElementById("stat-chunks").innerText = s.totalChunks || 0;
    }

    function initializeNodePositions() {
      const rect = canvas.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;

      graphData.nodes.forEach((n, idx) => {
        const angle = (idx / graphData.nodes.length) * 2 * Math.PI;
        const dist = 100 + Math.random() * 250;
        n.x = cx + Math.cos(angle) * dist;
        n.y = cy + Math.sin(angle) * dist;
        n.vx = 0;
        n.vy = 0;
      });
    }

    function applyFilters() {
      const titleFilter = document.getElementById("filter-title-input")?.value?.trim()?.toLowerCase() || "";
      const visibleTypes = new Set([...document.querySelectorAll("[data-node-type]:checked")].map(input => input.dataset.nodeType));
      const visibleRelations = new Set([...document.querySelectorAll("[data-relation]:checked")].map(input => input.dataset.relation));

      const nodeMap = new Map();
      filteredNodes = graphData.nodes.filter(n => {
        if (!visibleTypes.has(n.type)) return false;
        if (titleFilter && !n.name.toLowerCase().includes(titleFilter)) return false;
        nodeMap.set(n.id, n);
        return true;
      });

      filteredEdges = graphData.edges.filter(e => {
        return visibleRelations.has(e.relation) && nodeMap.has(e.source) && nodeMap.has(e.target);
      });

      document.getElementById("visible-count").innerText = \`\${filteredNodes.length} nodes visible\`;
      sim.alpha = 0.5;
    }

    // Tab Navigation
    document.getElementById("tab-btn-search").onclick = () => {
      document.getElementById("tab-btn-search").className = "py-1.5 px-2 rounded-lg font-medium text-white bg-blue-600 shadow transition flex items-center justify-center space-x-1.5";
      document.getElementById("tab-btn-filters").className = "py-1.5 px-2 rounded-lg font-medium text-slate-400 hover:text-slate-200 transition flex items-center justify-center space-x-1.5";
      document.getElementById("tab-content-search").classList.remove("hidden");
      document.getElementById("tab-content-filters").classList.add("hidden");
    };

    document.getElementById("tab-btn-filters").onclick = () => {
      document.getElementById("tab-btn-filters").className = "py-1.5 px-2 rounded-lg font-medium text-white bg-blue-600 shadow transition flex items-center justify-center space-x-1.5";
      document.getElementById("tab-btn-search").className = "py-1.5 px-2 rounded-lg font-medium text-slate-400 hover:text-slate-200 transition flex items-center justify-center space-x-1.5";
      document.getElementById("tab-content-filters").classList.remove("hidden");
      document.getElementById("tab-content-search").classList.add("hidden");
    };

    // Mode Buttons
    document.querySelectorAll(".mode-btn").forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll(".mode-btn").forEach(b => {
          b.className = "mode-btn py-1 px-1.5 rounded text-[11px] font-medium border border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-700";
        });
        btn.className = "mode-btn py-1 px-1.5 rounded text-[11px] font-medium border border-blue-500 bg-blue-500/20 text-blue-300";
        searchMode = btn.dataset.mode;
      };
    });

    // Execute Vector, BM25, or Hybrid Search
    async function executeSearch() {
      const query = document.getElementById("search-query").value.trim();
      if (!query) return;

      const limit = Number(document.getElementById("search-limit").value) || 10;
      const spinner = document.getElementById("search-spinner");
      const btnText = document.getElementById("search-btn-text");
      const status = document.getElementById("search-status");
      const matchCount = document.getElementById("search-match-count");
      const resultsContainer = document.getElementById("search-results-list");
      const clearBtn = document.getElementById("btn-clear-search");

      spinner.classList.remove("hidden");
      btnText.innerText = "Searching...";
      status.innerText = \`Running \${searchMode.toUpperCase()} search...\`;

      try {
        let endpoint = \`/api/search/\${searchMode}\`;
        let serverBase = window.location.origin.includes("localhost:3333") ? "" : "http://localhost:3333";
        
        const response = await fetch(serverBase + endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, limit })
        });

        if (!response.ok) {
          throw new Error(\`Search request returned status \${response.status}\`);
        }

        const data = await response.json();
        searchResults = data.results || [];
        searchResultMap.clear();

        resultsContainer.innerHTML = "";
        clearBtn.classList.remove("hidden");

        if (searchResults.length === 0) {
          status.innerText = "No matches found.";
          matchCount.innerText = "0 results";
          resultsContainer.innerHTML = '<div class="text-center py-6 text-slate-500 text-xs">No chunks matched your query.</div>';
          return;
        }

        status.innerText = \`Ranked by \${searchMode === "vector" ? "Cosine Distance" : (searchMode === "bm25" ? "BM25 Score" : "RRF Fusion")}\`;
        matchCount.innerText = \`\${searchResults.length} matches\`;

        // Populate Result Cards & Map
        const nodeMap = new Map(graphData.nodes.map(n => [n.id, n]));

        searchResults.forEach((r, idx) => {
          const rank = idx + 1;
          let node = r.entity_id ? nodeMap.get(r.entity_id) : null;
          if (!node && r.source_title) {
            node = graphData.nodes.find(n => n.name.toLowerCase() === r.source_title.toLowerCase());
          }

          if (node) {
            searchResultMap.set(node.id, { rank, score: r.score ?? r.distance, ...r });
          }

          const card = document.createElement("div");
          card.className = "p-2.5 rounded-lg bg-slate-900/90 border border-slate-800 hover:border-blue-500/60 transition cursor-pointer space-y-1.5 shadow-sm";
          
          let scoreTag = "";
          if (searchMode === "vector") {
            const dist = typeof r.distance === "number" ? r.distance.toFixed(3) : r.distance;
            const sim = typeof r.cosineSimilarity === "number" ? \` • Sim: \${r.cosineSimilarity.toFixed(3)}\` : "";
            scoreTag = \`<span class="px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300 font-mono text-[9px] border border-blue-700/50">Dist: \${dist}\${sim}</span>\`;
          } else if (searchMode === "bm25") {
            const sc = typeof r.score === "number" ? r.score.toFixed(2) : r.score;
            scoreTag = \`<span class="px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 font-mono text-[9px] border border-emerald-700/50">BM25: \${sc}</span>\`;
          } else {
            const sc = typeof r.score === "number" ? r.score.toFixed(4) : r.score;
            const ranks = [r.vecRank ? \`Vec #\${r.vecRank}\` : null, r.bmRank ? \`BM #\${r.bmRank}\` : null].filter(Boolean).join(" • ");
            scoreTag = \`<span class="px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-300 font-mono text-[9px] border border-purple-700/50">\${ranks}</span>\`;
          }

          card.innerHTML = \`
            <div class="flex items-center justify-between">
              <div class="flex items-center space-x-1.5 truncate">
                <span class="w-4 h-4 rounded-full bg-blue-600 text-[10px] font-bold text-white flex items-center justify-center shrink-0">#\${rank}</span>
                <span class="font-semibold text-slate-200 text-xs truncate">\${escapeHtml(r.source_title || "Unknown Note")}</span>
              </div>
              \${scoreTag}
            </div>
            <div class="text-[11px] text-slate-400 line-clamp-3 leading-relaxed break-words bg-slate-950/60 p-1.5 rounded font-sans">
              \${r.preview || escapeHtml((r.text_content || "").slice(0, 150))}
            </div>
            <div class="flex items-center justify-between text-[10px] pt-1">
              <span class="text-slate-500 font-mono">Chunk #\${r.chunk_index ?? 0}</span>
              <div class="flex items-center space-x-2">
                <button class="open-result-btn text-slate-400 hover:text-cyan-300 font-medium px-1.5 py-0.5 rounded bg-slate-800/80 hover:bg-slate-700 transition cursor-pointer" title="Open source file externally">↗ Open</button>
                <span class="text-blue-400 hover:text-blue-300 font-medium">Focus →</span>
              </div>
            </div>
          \`;

          const openResultBtn = card.querySelector('.open-result-btn');
          openResultBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            openResultBtn.textContent = '...';
            openExternally({ chunkId: r.id, uri: r.source_uri }).then(() => {
              openResultBtn.textContent = '✓';
              setTimeout(() => { openResultBtn.textContent = '↗ Open'; }, 2000);
            });
          });

          card.onclick = () => {
            if (node) {
              focusOnNode(node);
              selectNode(node);
            }
          };

          resultsContainer.appendChild(card);
        });

        // Highlight in graph & trigger physics wakeup
        sim.alpha = 0.3;
        render();

      } catch (err) {
        console.error("Search error:", err);
        status.innerText = "Error running search.";
        resultsContainer.innerHTML = \`<div class="p-3 bg-red-900/20 border border-red-800 rounded text-red-300 text-xs">\${escapeHtml(err.message)}</div>\`;
      } finally {
        spinner.classList.add("hidden");
        btnText.innerText = "Search";
      }
    }

    document.getElementById("btn-run-search").onclick = executeSearch;
    document.getElementById("search-query").addEventListener("keydown", (e) => {
      if (e.key === "Enter") executeSearch();
    });

    document.getElementById("btn-clear-search").onclick = () => {
      document.getElementById("search-query").value = "";
      searchResults = [];
      searchResultMap.clear();
      document.getElementById("search-results-list").innerHTML = '<div class="text-center py-8 text-slate-500 text-xs">Type a concept or question above and click Search.</div>';
      document.getElementById("btn-clear-search").classList.add("hidden");
      document.getElementById("search-status").innerText = "Ready to search";
      document.getElementById("search-match-count").innerText = "";
      render();
    };

    function focusOnNode(node) {
      const rect = canvas.getBoundingClientRect();
      camera.scale = 1.4;
      camera.x = (rect.width / 2) - node.x * camera.scale;
      camera.y = (rect.height / 2) - node.y * camera.scale;
      sim.alpha = 0.2;
    }

    function simStep() {
      if (!physicsRunning || sim.alpha < sim.alphaMin) return;

      const rect = canvas.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const nodes = filteredNodes;
      const edges = filteredEdges;

      // 1. Repulsion
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distSq = dx * dx + dy * dy;
          if (distSq < 1) distSq = 1;
          const dist = Math.sqrt(distSq);

          if (dist < 400) {
            const force = (sim.repulsion / distSq) * sim.alpha;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx -= fx;
            a.vy -= fy;
            b.vx += fx;
            b.vy += fy;
          }
        }

        // Center gravity
        a.vx += (cx - a.x) * sim.centering * sim.alpha;
        a.vy += (cy - a.y) * sim.centering * sim.alpha;
      }

      // 2. Spring Forces
      const nodeIndexMap = new Map();
      nodes.forEach(n => nodeIndexMap.set(n.id, n));

      for (const edge of edges) {
        const s = nodeIndexMap.get(edge.source);
        const t = nodeIndexMap.get(edge.target);
        if (!s || !t) continue;

        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const targetLen = edge.relation === "IN_SAME_VAULT" ? 180 : sim.springLength;
        const displacement = dist - targetLen;
        const force = displacement * sim.springStrength * sim.alpha;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        s.vx += fx;
        s.vy += fy;
        t.vx -= fx;
        t.vy -= fy;
      }

      // 2b. KNN Attraction Springs
      if (activeKnn && activeKnn.sourceNode && activeKnn.neighbors) {
        const s = nodeIndexMap.get(activeKnn.sourceNode.id);
        if (s) {
          for (const knn of activeKnn.neighbors) {
            if (!knn.entityId) continue;
            const t = nodeIndexMap.get(knn.entityId);
            if (!t) continue;
            const dx = t.x - s.x;
            const dy = t.y - s.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const targetLen = 100 + (1 - (knn.cosineSimilarity || 0.5)) * 140;
            const displacement = dist - targetLen;
            const force = displacement * 0.003 * sim.alpha;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            s.vx += fx;
            s.vy += fy;
            t.vx -= fx;
            t.vy -= fy;
          }
        }
      }

      // 3. Apply velocity
      for (const node of nodes) {
        if (node === draggedNode) continue;
        node.vx *= sim.friction;
        node.vy *= sim.friction;
        node.x += node.vx;
        node.y += node.vy;
      }

      sim.alpha *= (1 - sim.alphaDecay);
    }

    function simLoop() {
      simStep();
      render();
      requestAnimationFrame(simLoop);
    }

    function render() {
      const rect = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);

      ctx.save();
      ctx.translate(camera.x, camera.y);
      ctx.scale(camera.scale, camera.scale);

      const nodeMap = new Map();
      filteredNodes.forEach(n => nodeMap.set(n.id, n));

      // Draw Edges
      for (const edge of filteredEdges) {
        const s = nodeMap.get(edge.source);
        const t = nodeMap.get(edge.target);
        if (!s || !t) continue;

        const isHighlighted = (selectedNode && (s.id === selectedNode.id || t.id === selectedNode.id)) ||
                              (hoveredNode && (s.id === hoveredNode.id || t.id === hoveredNode.id));

        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);

        if (edge.relation === "IN_SAME_VAULT") {
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = isHighlighted ? "rgba(168, 85, 247, 0.7)" : EDGE_COLORS["IN_SAME_VAULT"];
          ctx.lineWidth = isHighlighted ? 2 : 1;
        } else {
          ctx.setLineDash([]);
          ctx.strokeStyle = isHighlighted ? "#38bdf8" : (EDGE_COLORS[edge.relation] || "#475569");
          ctx.lineWidth = isHighlighted ? 2.5 : 1.2;
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw Active KNN Similarity Links
      if (activeKnn && activeKnn.sourceNode && activeKnn.neighbors) {
        const s = nodeMap.get(activeKnn.sourceNode.id);
        if (s) {
          for (const knn of activeKnn.neighbors) {
            if (!knn.entityId) continue;
            const t = nodeMap.get(knn.entityId);
            if (!t) continue;

            ctx.save();
            ctx.beginPath();
            ctx.moveTo(s.x, s.y);
            ctx.lineTo(t.x, t.y);
            ctx.setLineDash([5, 3]);
            ctx.strokeStyle = "rgba(6, 182, 212, 0.85)";
            ctx.lineWidth = Math.max(1.5, Math.min(3.5, (knn.cosineSimilarity || 0.5) * 3.5));
            ctx.stroke();

            // Similarity percentage pill
            const midX = (s.x + t.x) / 2;
            const midY = (s.y + t.y) / 2;
            const simPct = (knn.cosineSimilarity * 100).toFixed(1) + "%";
            ctx.setLineDash([]);
            ctx.font = "bold 9px monospace";
            const textWidth = ctx.measureText(simPct).width;
            ctx.fillStyle = "rgba(8, 20, 36, 0.9)";
            ctx.strokeStyle = "rgba(6, 182, 212, 0.6)";
            ctx.lineWidth = 1;
            if (ctx.roundRect) {
              ctx.beginPath();
              ctx.roundRect(midX - textWidth / 2 - 4, midY - 7, textWidth + 8, 14, 3);
              ctx.fill();
              ctx.stroke();
            } else {
              ctx.fillRect(midX - textWidth / 2 - 4, midY - 7, textWidth + 8, 14);
              ctx.strokeRect(midX - textWidth / 2 - 4, midY - 7, textWidth + 8, 14);
            }
            ctx.fillStyle = "#22d3ee";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(simPct, midX, midY);
            ctx.restore();
          }
        }
      }

      // Draw Nodes
      for (const node of filteredNodes) {
        const style = nodeStyle(node.type);
        const isSelected = selectedNode && selectedNode.id === node.id;
        const isHovered = hoveredNode && hoveredNode.id === node.id;
        const isConnected = selectedNode && filteredEdges.some(e => 
          (e.source === selectedNode.id && e.target === node.id) ||
          (e.target === selectedNode.id && e.source === node.id)
        );
        const searchHit = searchResultMap.get(node.id);
        const knnHit = activeKnn?.neighborMap?.get(node.id);
        const isKnnSource = activeKnn?.sourceNode?.id === node.id;

        let radius = style.radius + Math.min(node.degree * 0.5, 6);
        if (isSelected || isHovered) radius += 4;
        if (searchHit || knnHit || isKnnSource) radius += 3;

        // Draw Search Hit Glow Ring
        if (searchHit) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius + 7, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(245, 158, 11, 0.25)";
          ctx.fill();
          ctx.strokeStyle = "#f59e0b";
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Draw KNN Source Ring / Halo
        if (isKnnSource) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius + 8, 0, Math.PI * 2);
          ctx.strokeStyle = "#06b6d4";
          ctx.lineWidth = 2.5;
          ctx.setLineDash([4, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (knnHit) {
          // Draw KNN Neighbor Glow Ring
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius + 6, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(6, 182, 212, 0.25)";
          ctx.fill();
          ctx.strokeStyle = "#06b6d4";
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = searchHit ? "#d97706" : (knnHit ? "#0e7490" : style.bg);
        ctx.fill();

        ctx.strokeStyle = isSelected ? "#ffffff" : (searchHit ? "#fef08a" : (knnHit ? "#22d3ee" : (isHovered || isConnected ? "#fef08a" : style.border)));
        ctx.lineWidth = isSelected ? 3 : (searchHit || knnHit ? 2.5 : (isHovered ? 2.5 : 1.5));
        ctx.stroke();

        // Search Rank Badge over Node
        if (searchHit) {
          ctx.beginPath();
          ctx.arc(node.x + radius * 0.7, node.y - radius * 0.7, 7, 0, Math.PI * 2);
          ctx.fillStyle = "#ef4444";
          ctx.fill();
          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 8px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(searchHit.rank), node.x + radius * 0.7, node.y - radius * 0.7);
        } else if (knnHit) {
          // KNN Rank Badge over Node
          ctx.beginPath();
          ctx.arc(node.x + radius * 0.7, node.y - radius * 0.7, 7, 0, Math.PI * 2);
          ctx.fillStyle = "#0891b2";
          ctx.fill();
          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 8px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(knnHit.rank), node.x + radius * 0.7, node.y - radius * 0.7);
        }

        // Node Label
        if (node.type === "Vault" || node.type === "WebSession" || isSelected || isHovered || searchHit || knnHit || isKnnSource || node.degree > 3 || camera.scale > 1.2) {
          ctx.font = \`\${node.type === "Vault" ? "bold 13px" : (searchHit || knnHit ? "bold 11px" : "11px")} sans-serif\`;
          ctx.fillStyle = isSelected ? "#ffffff" : (searchHit ? "#fef08a" : (knnHit ? "#67e8f9" : (isKnnSource ? "#38bdf8" : "#cbd5e1")));
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(node.name, node.x, node.y + radius + 12);
        }
      }

      ctx.restore();
    }

    function recenterView() {
      if (filteredNodes.length === 0) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of filteredNodes) {
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      }
      const rect = canvas.getBoundingClientRect();
      const width = maxX - minX || 1;
      const height = maxY - minY || 1;
      const scaleX = (rect.width * 0.75) / width;
      const scaleY = (rect.height * 0.75) / height;
      camera.scale = Math.max(0.2, Math.min(1.5, Math.min(scaleX, scaleY)));
      camera.x = (rect.width / 2) - ((minX + maxX) / 2) * camera.scale;
      camera.y = (rect.height / 2) - ((minY + maxY) / 2) * camera.scale;
    }

    function screenToWorld(sx, sy) {
      return {
        x: (sx - camera.x) / camera.scale,
        y: (sy - camera.y) / camera.scale
      };
    }

    function findNodeAt(sx, sy) {
      const w = screenToWorld(sx, sy);
      for (let i = filteredNodes.length - 1; i >= 0; i--) {
        const n = filteredNodes[i];
        const style = nodeStyle(n.type);
        const r = style.radius + 6;
        const dx = n.x - w.x;
        const dy = n.y - w.y;
        if (dx * dx + dy * dy <= r * r) {
          return n;
        }
      }
      return null;
    }

    // Helper to open a file/source/chunk externally
    async function openExternally(params, feedbackElem) {
      if (feedbackElem) {
        feedbackElem.innerText = "Opening...";
        feedbackElem.classList.remove("hidden");
      }
      try {
        const res = await fetch("/api/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to open externally");
        if (feedbackElem) {
          feedbackElem.innerText = data.openedWith === "obsidian" ? "Opened in Obsidian!" : "Opened in system app!";
          setTimeout(() => { feedbackElem.classList.add("hidden"); }, 2500);
        }
        return data;
      } catch (err) {
        if (feedbackElem) {
          feedbackElem.innerText = "Error opening";
          setTimeout(() => { feedbackElem.classList.add("hidden"); }, 2500);
        }
        console.error("Open error:", err);
      }
    }

    // Inspector Panel Population
    function selectNode(node) {
      selectedNode = node;
      const details = document.getElementById("inspector-details");
      const empty = document.getElementById("inspector-empty");

      if (!node) {
        details.classList.add("hidden");
        empty.classList.remove("hidden");
        return;
      }

      empty.classList.add("hidden");
      details.classList.remove("hidden");

      document.getElementById("detail-title").innerText = node.name;
      document.getElementById("detail-namespace").innerText = \`[\${node.namespace}]\`;
      document.getElementById("detail-uri").innerText = node.sourceUri || "No source URI recorded";
      document.getElementById("detail-degree").innerText = node.degree;
      document.getElementById("detail-chunks-count").innerText = node.chunksCount || 0;

      // Configure Source Actions Bar
      const actionsBar = document.getElementById("source-actions-bar");
      const btnOpenSystem = document.getElementById("btn-open-system");
      const btnOpenObsidian = document.getElementById("btn-open-obsidian");
      const linkOpenBrowser = document.getElementById("link-open-browser");
      const btnCopyPath = document.getElementById("btn-copy-path");
      const feedback = document.getElementById("open-action-feedback");
      feedback?.classList.add("hidden");

      if (node.sourceUri) {
        actionsBar?.classList.remove("hidden");
        const cleanPath = decodeURIComponent(node.sourceUri.replace("file://", ""));
        linkOpenBrowser.href = \`/api/file/raw?uri=\${encodeURIComponent(node.sourceUri)}\`;

        btnOpenSystem.onclick = (e) => {
          e.stopPropagation();
          openExternally({ uri: node.sourceUri, app: "system" }, feedback);
        };

        if (node.type === "Note") {
          btnOpenObsidian.style.display = "inline-flex";
          btnOpenObsidian.onclick = (e) => {
            e.stopPropagation();
            openExternally({ uri: node.sourceUri, app: "obsidian" }, feedback);
          };
        } else {
          btnOpenObsidian.style.display = "none";
        }

        btnCopyPath.onclick = (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(cleanPath).then(() => {
            feedback.innerText = "Copied Path!";
            feedback.classList.remove("hidden");
            setTimeout(() => { feedback.classList.add("hidden"); }, 2000);
          });
        };
      } else {
        actionsBar?.classList.add("hidden");
      }

      const badge = document.getElementById("detail-type-badge");
      badge.innerText = node.type;
      badge.className = "px-2 py-0.5 rounded text-[10px] font-semibold tracking-wider uppercase " + 
        (node.type === "Vault" || node.type === "WebSession" ? "badge-vault" : (node.type === "Image" ? "badge-image" : "badge-note"));

      // KNN Section state
      const knnSection = document.getElementById("knn-section");
      const knnResultsContainer = document.getElementById("knn-results-container");
      const btnClearKnn = document.getElementById("btn-clear-knn");

      if (node.type === "Vault") {
        knnSection?.classList.add("hidden");
      } else {
        knnSection?.classList.remove("hidden");
        if (activeKnn && activeKnn.sourceNode.id === node.id) {
          knnResultsContainer?.classList.remove("hidden");
          btnClearKnn?.classList.remove("hidden");
        } else if (!activeKnn) {
          knnResultsContainer?.classList.add("hidden");
          btnClearKnn?.classList.add("hidden");
        }
      }

      // Connected items
      const connList = document.getElementById("detail-connections-list");
      connList.innerHTML = "";
      const nodeMap = new Map(graphData.nodes.map(n => [n.id, n]));

      const relatedEdges = graphData.edges.filter(e => e.source === node.id || e.target === node.id);
      if (relatedEdges.length === 0) {
        connList.innerHTML = '<div class="text-slate-500 italic">No connected relationships</div>';
      } else {
        relatedEdges.forEach(e => {
          const isSource = e.source === node.id;
          const otherId = isSource ? e.target : e.source;
          const otherNode = nodeMap.get(otherId);
          if (!otherNode) return;

          const row = document.createElement("div");
          row.className = "flex items-center justify-between p-1.5 rounded bg-slate-900/60 hover:bg-slate-800 cursor-pointer border border-slate-800 transition";
          row.innerHTML = \`
            <div class="flex items-center space-x-1.5 truncate">
              <span class="text-[10px] text-slate-500 font-mono">\${isSource ? "→" : "←"}</span>
              <span class="truncate font-medium text-slate-200">\${otherNode.name}</span>
            </div>
            <span class="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono border border-slate-700">\${e.relation}</span>
          \`;
          row.onclick = () => {
            selectNode(otherNode);
            focusOnNode(otherNode);
          };
          connList.appendChild(row);
        });
      }

      // Chunks
      const chunksList = document.getElementById("detail-chunks-list");
      chunksList.innerHTML = "";
      if (!node.chunks || node.chunks.length === 0) {
        chunksList.innerHTML = '<div class="text-slate-500 italic">No chunks ingested</div>';
      } else {
        node.chunks.forEach(c => {
          const item = document.createElement("div");
          item.className = "p-2.5 rounded bg-slate-900/80 border border-slate-800 space-y-1.5";
          const text = c.text_content || "";
          const isLong = text.length > 500;
          const charCount = text.length.toLocaleString();

          item.innerHTML = \`
            <div class="flex items-center justify-between text-[10px] text-slate-500 font-mono">
              <span class="font-medium text-slate-400">Chunk #\${c.chunk_index} <span class="text-slate-600">(id: \${c.id})</span></span>
              <div class="flex items-center space-x-2">
                <span class="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700/60">\${charCount} chars</span>
                <span class="text-blue-400">4096-dim vector</span>
                <button class="open-chunk-btn text-slate-400 hover:text-cyan-300 transition text-[11px] cursor-pointer" title="Open source file externally">↗ Open</button>
                <button class="copy-chunk-btn text-slate-400 hover:text-white transition text-[11px] cursor-pointer" title="Copy chunk text">📋</button>
              </div>
            </div>
            <div class="chunk-box \${isLong ? 'max-h-72 overflow-y-auto custom-scroll p-2.5 rounded bg-slate-950/70 border border-slate-800/80' : ''}">
              <p class="chunk-text text-slate-300 text-[11px] leading-relaxed break-words whitespace-pre-wrap font-sans select-text">\${escapeHtml(text)}</p>
            </div>
            \${isLong ? \`
              <div class="flex justify-end pt-0.5">
                <button class="toggle-expand-btn text-[10px] text-blue-400 hover:text-blue-300 font-medium cursor-pointer">Expand to full</button>
              </div>
            \` : ''}
          \`;

          const openChunkBtn = item.querySelector('.open-chunk-btn');
          openChunkBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            openChunkBtn.textContent = '...';
            openExternally({ chunkId: c.id }).then(() => {
              openChunkBtn.textContent = '✓';
              setTimeout(() => { openChunkBtn.textContent = '↗ Open'; }, 2000);
            });
          });

          const copyBtn = item.querySelector('.copy-chunk-btn');
          copyBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(text).then(() => {
              copyBtn.textContent = '✓';
              setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
            }).catch(() => {});
          });

          if (isLong) {
            const toggleBtn = item.querySelector('.toggle-expand-btn');
            const box = item.querySelector('.chunk-box');
            let isExpanded = false;
            toggleBtn?.addEventListener('click', (e) => {
              e.stopPropagation();
              isExpanded = !isExpanded;
              if (isExpanded) {
                box?.classList.remove('max-h-72');
                toggleBtn.textContent = 'Collapse view';
              } else {
                box?.classList.add('max-h-72');
                toggleBtn.textContent = 'Expand to full';
              }
            });
          }

          chunksList.appendChild(item);
        });
      }
    }

    function escapeHtml(str) {
      return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // Events
    window.addEventListener("resize", resizeCanvas);

    canvas.addEventListener("mousedown", (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      const hit = findNodeAt(sx, sy);
      if (hit) {
        draggedNode = hit;
        sim.alpha = 0.4;
        selectNode(hit);
      } else {
        isDraggingCanvas = true;
        dragStart = { x: e.clientX - camera.x, y: e.clientY - camera.y };
      }
    });

    window.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (draggedNode) {
        const w = screenToWorld(sx, sy);
        draggedNode.x = w.x;
        draggedNode.y = w.y;
        draggedNode.vx = 0;
        draggedNode.vy = 0;
        sim.alpha = 0.4;
        return;
      }

      if (isDraggingCanvas) {
        camera.x = e.clientX - dragStart.x;
        camera.y = e.clientY - dragStart.y;
        return;
      }

      // Hover
      const hit = findNodeAt(sx, sy);
      hoveredNode = hit;
      const tooltip = document.getElementById("node-tooltip");
      if (hit) {
        tooltip.style.left = \`\${sx + 14}px\`;
        tooltip.style.top = \`\${sy + 10}px\`;
        document.getElementById("tooltip-title").innerText = hit.name;
        
        const searchHit = searchResultMap.get(hit.id);
        const searchExtra = searchHit ? \` | Rank #\${searchHit.rank}\` : "";
        document.getElementById("tooltip-meta").innerText = \`Type: \${hit.type} | Links: \${hit.degree}\${searchExtra}\`;
        tooltip.classList.remove("hidden");
      } else {
        tooltip.classList.add("hidden");
      }
    });

    window.addEventListener("mouseup", () => {
      draggedNode = null;
      isDraggingCanvas = false;
    });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;

      const prevScale = camera.scale;
      const nextScale = Math.max(0.1, Math.min(4.0, camera.scale * zoomFactor));

      camera.x = sx - (sx - camera.x) * (nextScale / prevScale);
      camera.y = sy - (sy - camera.y) * (nextScale / prevScale);
      camera.scale = nextScale;
    }, { passive: false });

    // Buttons
    document.getElementById("btn-recenter").onclick = recenterView;
    document.getElementById("btn-zoom-in").onclick = () => {
      camera.scale = Math.min(4.0, camera.scale * 1.25);
    };
    document.getElementById("btn-zoom-out").onclick = () => {
      camera.scale = Math.max(0.1, camera.scale * 0.8);
    };
    document.getElementById("btn-toggle-physics").onclick = function() {
      physicsRunning = !physicsRunning;
      this.innerText = physicsRunning ? "Pause Physics" : "Resume Physics";
      this.className = physicsRunning ? 
        "px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded shadow transition" :
        "px-2.5 py-1 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded shadow transition";
    };

    document.getElementById("filter-title-input")?.addEventListener("input", applyFilters);

    // KNN Controls & Framing
    function frameKnnCluster(sourceNode, neighbors) {
      const nodeMap = new Map(filteredNodes.map(n => [n.id, n]));
      const cluster = [sourceNode];
      neighbors.forEach(n => {
        if (!n.entityId) return;
        const node = nodeMap.get(n.entityId);
        if (node) cluster.push(node);
      });

      if (cluster.length <= 1) {
        focusOnNode(sourceNode);
        return;
      }

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      cluster.forEach(n => {
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      });

      const rect = canvas.getBoundingClientRect();
      const width = Math.max(120, maxX - minX + 180);
      const height = Math.max(120, maxY - minY + 180);
      const scaleX = (rect.width * 0.7) / width;
      const scaleY = (rect.height * 0.7) / height;
      camera.scale = Math.max(0.3, Math.min(1.8, Math.min(scaleX, scaleY)));
      const midX = (minX + maxX) / 2;
      const midY = (minY + maxY) / 2;
      camera.x = (rect.width / 2) - midX * camera.scale;
      camera.y = (rect.height / 2) - midY * camera.scale;
    }

    document.getElementById("btn-find-knn").onclick = async function() {
      if (!selectedNode) return;
      const kInput = document.getElementById("knn-k-input");
      const kVal = Math.max(1, Math.min(50, parseInt(kInput.value) || 5));
      kInput.value = kVal;

      const btn = document.getElementById("btn-find-knn");
      const btnClear = document.getElementById("btn-clear-knn");
      const resultsContainer = document.getElementById("knn-results-container");
      const resultsList = document.getElementById("knn-results-list");
      const statusText = document.getElementById("knn-status-text");
      const countText = document.getElementById("knn-active-count");

      btn.disabled = true;
      btn.innerHTML = '<span>Searching...</span>';
      resultsContainer.classList.remove("hidden");
      resultsList.innerHTML = '<div class="text-center py-4 text-slate-500 text-xs">Querying vector embeddings...</div>';

      try {
        const res = await fetch("/api/neighbors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entityId: selectedNode.id, k: kVal }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to find neighbors");

        const neighborMap = new Map();
        data.neighbors.forEach(n => {
          if (n.entityId) neighborMap.set(n.entityId, n);
        });

        activeKnn = {
          sourceNode: selectedNode,
          k: kVal,
          neighbors: data.neighbors,
          neighborMap,
        };

        countText.innerText = \`\${data.neighbors.length} found\`;
        statusText.innerText = \`Top \${data.neighbors.length} nearest to "\${selectedNode.name}"\`;
        btnClear.classList.remove("hidden");

        resultsList.innerHTML = "";
        if (data.neighbors.length === 0) {
          resultsList.innerHTML = '<div class="text-center py-4 text-slate-500 text-xs">No vector neighbors found.</div>';
        } else {
          data.neighbors.forEach(n => {
            const card = document.createElement("div");
            card.className = "p-2 rounded bg-slate-950/70 border border-slate-800/80 hover:border-cyan-500/50 cursor-pointer space-y-1 transition";
            const simPct = (n.cosineSimilarity * 100).toFixed(1);
            const badgeClass = n.entityType === "Image" ? "badge-image" : "badge-note";

            card.innerHTML = \`
              <div class="flex items-center justify-between">
                <div class="flex items-center space-x-1.5 truncate">
                  <span class="w-4 h-4 rounded-full bg-cyan-600 text-[10px] font-bold text-white flex items-center justify-center shrink-0">#\${n.rank}</span>
                  <span class="font-semibold text-slate-200 text-xs truncate">\${escapeHtml(n.sourceTitle || n.entityName)}</span>
                </div>
                <span class="px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-300 font-mono text-[9px] border border-cyan-800/50">\${simPct}% sim</span>
              </div>
              <p class="text-[10px] text-slate-400 line-clamp-2 leading-relaxed break-words">\${escapeHtml(n.preview || "")}</p>
              <div class="flex items-center justify-between text-[9px] pt-0.5 text-slate-500 font-mono">
                <span class="px-1 py-0.2 rounded \${badgeClass}">\${n.entityType}</span>
                <div class="flex items-center space-x-2">
                  <button class="open-knn-btn text-slate-400 hover:text-cyan-300 font-medium px-1.5 py-0.5 rounded bg-slate-800/80 hover:bg-slate-700 transition cursor-pointer" title="Open source file externally">↗ Open</button>
                  <span class="text-cyan-400 hover:text-cyan-300 font-medium">Focus →</span>
                </div>
              </div>
            \`;

            const openKnnBtn = card.querySelector('.open-knn-btn');
            openKnnBtn?.addEventListener('click', (e) => {
              e.stopPropagation();
              openKnnBtn.textContent = '...';
              openExternally({ chunkId: n.chunkId, uri: n.sourceUri }).then(() => {
                openKnnBtn.textContent = '✓';
                setTimeout(() => { openKnnBtn.textContent = '↗ Open'; }, 2000);
              });
            });

            card.onclick = () => {
              const nodeMap = new Map(graphData.nodes.map(node => [node.id, node]));
              const targetNode = nodeMap.get(n.entityId);
              if (targetNode) {
                focusOnNode(targetNode);
                selectNode(targetNode);
              }
            };

            resultsList.appendChild(card);
          });
        }

        // Frame cluster and trigger physics wakeup
        frameKnnCluster(selectedNode, data.neighbors);
        sim.alpha = 0.35;
        render();

      } catch (err) {
        console.error("KNN error:", err);
        resultsList.innerHTML = \`<div class="p-2 bg-red-900/20 border border-red-800 rounded text-red-300 text-xs">\${escapeHtml(err.message)}</div>\`;
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>Find Neighbors</span>';
      }
    };

    document.getElementById("btn-clear-knn").onclick = function() {
      activeKnn = null;
      document.getElementById("knn-results-container").classList.add("hidden");
      document.getElementById("btn-clear-knn").classList.add("hidden");
      render();
    };

    // Start
    resizeCanvas();
    initData();
  </script>
</body>
</html>`;
}

export function startVisualizerServer(port: number = 3333) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  const entStmt = db.query<
    { id: number; name: string; type: string },
    { $name: string }
  >("SELECT id, name, type FROM entities WHERE name = $name LIMIT 1");

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
      }

      if (url.pathname === "/" && req.method === "GET") {
        const html = buildVisualizerHtml();
        return new Response(html, {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }

      if (url.pathname === "/api/graph" && req.method === "GET") {
        const data = getGraphData();
        return Response.json(data, { headers: corsHeaders });
      }

      // 1. Vector Search Endpoint
      if (url.pathname === "/api/search/vector" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            query?: string;
            limit?: number;
          };
          const query = body?.query?.trim();
          if (!query) {
            return Response.json(
              { error: "Query parameter required" },
              { status: 400, headers: corsHeaders },
            );
          }

          const limit = body.limit || 10;
          const rawResults = await sdk.search.vector({
            query,
            limit,
            embedderOptions: {
              instruction:
                "Given a web search query, retrieve relevant passages that answer the query",
            },
          });

          const results = rawResults.map((r) => {
            const entity = r.source_title
              ? entStmt.get({ $name: r.source_title })
              : null;
            return {
              ...r,
              entity_id: entity?.id,
              entity_name: entity?.name,
              preview: r.preview || r.text_content?.slice(0, 220),
            };
          });

          return Response.json(
            { query, effectiveQuery: query, results },
            { headers: corsHeaders },
          );
        } catch (err: any) {
          console.error("[Search] Vector search failed:", err);
          return Response.json(
            { error: err.message || "Vector search failed" },
            { status: 500, headers: corsHeaders },
          );
        }
      }

      // 2. BM25 Search Endpoint
      if (url.pathname === "/api/search/bm25" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            query?: string;
            limit?: number;
          };
          const query = body?.query?.trim();
          if (!query) {
            return Response.json(
              { error: "Query parameter required" },
              { status: 400, headers: corsHeaders },
            );
          }

          const limit = body.limit || 10;
          const rawResults = await sdk.search.bm25({
            query,
            limit,
          });

          const results = rawResults.map((r) => {
            const entity = r.source_title
              ? entStmt.get({ $name: r.source_title })
              : null;
            return {
              ...r,
              entity_id: entity?.id,
              entity_name: entity?.name,
            };
          });

          return Response.json({ query, results }, { headers: corsHeaders });
        } catch (err: any) {
          console.error("[Search] BM25 search failed:", err);
          return Response.json(
            { error: err.message || "BM25 search failed" },
            { status: 500, headers: corsHeaders },
          );
        }
      }

      // 3. Hybrid Search Endpoint (RRF Fusion)
      if (url.pathname === "/api/search/hybrid" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            query?: string;
            limit?: number;
          };
          const query = body?.query?.trim();
          if (!query) {
            return Response.json(
              { error: "Query parameter required" },
              { status: 400, headers: corsHeaders },
            );
          }

          const limit = body.limit || 10;
          let rawResults: ChunkSearchResult[] = [];

          try {
            rawResults = await sdk.search.hybrid({
              query,
              limit,
              vectorCandidateLimit: limit * 2,
              bm25CandidateLimit: limit * 2,
              vectorOptions: {
                embedderOptions: {
                  instruction:
                    "Given a web search query, retrieve relevant passages that answer the query",
                },
              },
              fusion: {
                strategy: "rrf",
                rrfK: 60,
                vectorWeight: 1.0,
                bm25Weight: 1.0,
              },
            });
          } catch (hybridErr) {
            console.warn(
              "[Search] Vector embed failed during hybrid, falling back to BM25:",
              hybridErr,
            );
            rawResults = await sdk.search.bm25({ query, limit });
          }

          const ranked = rawResults.map((r) => {
            const entity = r.source_title
              ? entStmt.get({ $name: r.source_title })
              : null;
            return {
              ...r,
              vecRank: r.fusionDetails?.vectorRank,
              bmRank: r.fusionDetails?.bmRank,
              entity_id: entity?.id,
              entity_name: entity?.name,
            };
          });

          return Response.json(
            { query, effectiveQuery: query, results: ranked },
            { headers: corsHeaders },
          );
        } catch (err: any) {
          console.error("[Search] Hybrid search failed:", err);
          return Response.json(
            { error: err.message || "Hybrid search failed" },
            { status: 500, headers: corsHeaders },
          );
        }
      }

      // 4. K-Nearest Neighbors Endpoint using SDK built-in vector search (KNN by chunkId)
      if (url.pathname === "/api/neighbors" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            entityId?: number;
            chunkId?: number;
            noteTitle?: string;
            k?: number;
          };

          const k = Math.max(1, Math.min(50, Number(body.k) || 5));
          let queryChunkId = body.chunkId;
          let sourceEntity: { id: number; name: string; type: string } | null = null;
          let sourceRecord: { id: string; title: string; uri: string } | null = null;

          if (queryChunkId === undefined) {
            if (body.entityId !== undefined) {
              sourceEntity = db
                .query<{ id: number; name: string; type: string }, { $id: number }>(
                  "SELECT id, name, type FROM entities WHERE id = $id",
                )
                .get({ $id: body.entityId });
            } else if (body.noteTitle) {
              sourceEntity = db
                .query<{ id: number; name: string; type: string }, { $name: string }>(
                  "SELECT id, name, type FROM entities WHERE lower(name) = lower($name) LIMIT 1",
                )
                .get({ $name: body.noteTitle });
            }

            if (!sourceEntity) {
              return Response.json(
                { error: "Note entity not found" },
                { status: 404, headers: corsHeaders },
              );
            }

            // Find matching source
            sourceRecord = db
              .query<{ id: string; title: string; uri: string }, { $name: string }>(
                "SELECT id, title, uri FROM sources WHERE lower(title) = lower($name) LIMIT 1",
              )
              .get({ $name: sourceEntity.name });

            if (!sourceRecord) {
              return Response.json(
                { error: `No source record found for note "${sourceEntity.name}"` },
                { status: 404, headers: corsHeaders },
              );
            }

            // Find primary chunk (lowest chunk_index)
            const chunkRow = db
              .query<{ id: number }, { $sourceId: string }>(
                "SELECT id FROM chunks WHERE source_id = $sourceId ORDER BY chunk_index ASC LIMIT 1",
              )
              .get({ $sourceId: sourceRecord.id });

            if (!chunkRow) {
              return Response.json(
                { error: `No text chunks found for note "${sourceEntity.name}"` },
                { status: 404, headers: corsHeaders },
              );
            }

            queryChunkId = chunkRow.id;
          } else {
            const chunkInfo = db
              .query<{ source_id: string; title: string }, { $id: number }>(
                "SELECT c.source_id, s.title FROM chunks c LEFT JOIN sources s ON c.source_id = s.id WHERE c.id = $id",
              )
              .get({ $id: queryChunkId });
            if (chunkInfo?.title) {
              sourceEntity = db
                .query<{ id: number; name: string; type: string }, { $name: string }>(
                  "SELECT id, name, type FROM entities WHERE lower(name) = lower($name) LIMIT 1",
                )
                .get({ $name: chunkInfo.title });
            }
          }

          // Use the built-in feature of the SDK: sdk.search.vector({ chunkId, limit, excludeSelf: true })
          const fetchLimit = Math.max(k * 4, 30);
          const rawResults = await sdk.search.vector({
            chunkId: queryChunkId,
            limit: fetchLimit,
            excludeSelf: true,
          });

          const neighbors: any[] = [];
          const seenEntityIds = new Set<number>();
          if (sourceEntity) {
            seenEntityIds.add(sourceEntity.id);
          }

          for (const r of rawResults) {
            if (neighbors.length >= k) break;

            const entity = r.source_title
              ? db
                  .query<{ id: number; name: string; type: string }, { $name: string }>(
                    "SELECT id, name, type FROM entities WHERE lower(name) = lower($name) LIMIT 1",
                  )
                  .get({ $name: r.source_title })
              : null;

            if (entity && seenEntityIds.has(entity.id)) {
              continue;
            }
            if (entity) {
              seenEntityIds.add(entity.id);
            }

            neighbors.push({
              rank: neighbors.length + 1,
              chunkId: r.id,
              chunkIndex: r.chunk_index,
              sourceId: r.source_id,
              sourceTitle: r.source_title,
              sourceUri: r.source_uri,
              entityId: entity?.id,
              entityName: entity?.name,
              entityType: entity?.type || "Note",
              cosineSimilarity: r.cosineSimilarity ?? 0,
              distance: r.distance ?? 0,
              preview: r.preview || (r.text_content ? r.text_content.slice(0, 180) : ""),
            });
          }

          return Response.json(
            {
              sourceNode: sourceEntity,
              sourceChunkId: queryChunkId,
              k,
              neighbors,
            },
            { headers: corsHeaders },
          );
        } catch (err: any) {
          console.error("[Neighbors] KNN vector search failed:", err);
          return Response.json(
            { error: err.message || "KNN vector search failed" },
            { status: 500, headers: corsHeaders },
          );
        }
      }

      // 5. Raw File Streaming Endpoint (View in Browser Tab)
      if (
        url.pathname === "/api/file/raw" &&
        (req.method === "GET" || req.method === "HEAD")
      ) {
        try {
          const uriParam = url.searchParams.get("uri");
          const pathParam = url.searchParams.get("path");
          const chunkIdParam = url.searchParams.get("chunkId");

          let targetPath = pathParam || "";
          if (!targetPath && chunkIdParam) {
            const chunkId = parseInt(chunkIdParam, 10);
            if (!isNaN(chunkId)) {
              const row = db
                .query<{ uri: string }, { $id: number }>(
                  "SELECT s.uri FROM chunks c LEFT JOIN sources s ON c.source_id = s.id WHERE c.id = $id",
                )
                .get({ $id: chunkId });
              if (row?.uri) {
                targetPath = decodeURIComponent(row.uri.replace(/^file:\/\//, ""));
              }
            }
          }

          if (!targetPath && uriParam) {
            targetPath = decodeURIComponent(uriParam.replace(/^file:\/\//, ""));
          }

          if (!targetPath) {
            return new Response("No file path or URI specified", {
              status: 400,
              headers: corsHeaders,
            });
          }

          const file = Bun.file(targetPath);
          if (!(await file.exists())) {
            return new Response(`File not found: ${targetPath}`, {
              status: 404,
              headers: corsHeaders,
            });
          }

          const headers = new Headers(corsHeaders);
          if (targetPath.endsWith(".md") || targetPath.endsWith(".markdown")) {
            headers.set("Content-Type", "text/plain; charset=utf-8");
          } else if (targetPath.endsWith(".png")) {
            headers.set("Content-Type", "image/png");
          } else if (targetPath.endsWith(".jpg") || targetPath.endsWith(".jpeg")) {
            headers.set("Content-Type", "image/jpeg");
          } else if (targetPath.endsWith(".webp")) {
            headers.set("Content-Type", "image/webp");
          } else if (targetPath.endsWith(".gif")) {
            headers.set("Content-Type", "image/gif");
          } else if (targetPath.endsWith(".svg")) {
            headers.set("Content-Type", "image/svg+xml");
          } else if (file.type) {
            headers.set("Content-Type", file.type);
          } else {
            headers.set("Content-Type", "application/octet-stream");
          }

          return new Response(file, { headers });
        } catch (err: any) {
          console.error("[Raw File] Failed to serve file:", err);
          return new Response(err.message || "Failed to serve file", {
            status: 500,
            headers: corsHeaders,
          });
        }
      }

      // 6. Open Externally Endpoint (Obsidian or System Desktop App)
      if (url.pathname === "/api/open" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            uri?: string;
            path?: string;
            chunkId?: number;
            entityId?: number;
            app?: "system" | "obsidian" | "auto";
          };

          let targetPath = body.path || "";
          let targetUri = body.uri || "";

          if (!targetPath && !targetUri && body.chunkId !== undefined) {
            const row = db
              .query<{ uri: string; title: string }, { $id: number }>(
                "SELECT s.uri, s.title FROM chunks c LEFT JOIN sources s ON c.source_id = s.id WHERE c.id = $id",
              )
              .get({ $id: body.chunkId });
            if (row?.uri) {
              targetUri = row.uri;
            }
          }

          if (!targetPath && !targetUri && body.entityId !== undefined) {
            const ent = db
              .query<{ name: string }, { $id: number }>(
                "SELECT name FROM entities WHERE id = $id",
              )
              .get({ $id: body.entityId });
            if (ent?.name) {
              const src = db
                .query<{ uri: string }, { $name: string }>(
                  "SELECT uri FROM sources WHERE lower(title) = lower($name) LIMIT 1",
                )
                .get({ $name: ent.name });
              if (src?.uri) {
                targetUri = src.uri;
              }
            }
          }

          if (!targetPath && targetUri) {
            targetPath = decodeURIComponent(targetUri.replace(/^file:\/\//, ""));
          }

          if (!targetPath) {
            return Response.json(
              { error: "Could not resolve file path or URI" },
              { status: 400, headers: corsHeaders },
            );
          }

          const file = Bun.file(targetPath);
          if (!(await file.exists())) {
            return Response.json(
              { error: `File does not exist on disk: ${targetPath}` },
              { status: 404, headers: corsHeaders },
            );
          }

          const requestedApp = body.app || "auto";
          let openTarget = targetPath;
          let openedWith = "system";

          const isMarkdown =
            targetPath.endsWith(".md") || targetPath.endsWith(".markdown");

          if (
            requestedApp === "obsidian" ||
            (requestedApp === "auto" && isMarkdown)
          ) {
            openTarget = `obsidian://open?path=${encodeURIComponent(targetPath)}`;
            openedWith = "obsidian";
          }

          let proc;
          if (process.platform === "darwin") {
            proc = Bun.spawn(["open", openTarget], {
              stdout: "ignore",
              stderr: "ignore",
            });
          } else if (process.platform === "win32") {
            proc = Bun.spawn(["cmd", "/c", "start", "", openTarget], {
              stdout: "ignore",
              stderr: "ignore",
            });
          } else {
            proc = Bun.spawn(["xdg-open", openTarget], {
              stdout: "ignore",
              stderr: "ignore",
            });
          }
          proc.unref();

          return Response.json(
            {
              success: true,
              openedWith,
              target: openTarget,
              path: targetPath,
            },
            { headers: corsHeaders },
          );
        } catch (err: any) {
          console.error("[Open] Failed to open externally:", err);
          return Response.json(
            { error: err.message || "Failed to open externally" },
            { status: 500, headers: corsHeaders },
          );
        }
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });
    },
  });

  console.log(
    `[Visualizer] Graph Visualizer live at http://localhost:${server.port}`,
  );
  return server;
}

if (import.meta.main) {
  startVisualizerServer(3333);
}
*/
