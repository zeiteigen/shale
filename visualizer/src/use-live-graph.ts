import { useCallback, useEffect, useRef, useState } from "react";
import { getGraph } from "./api";
import type { GraphData } from "./types";

/** Follow external MCP and connector changes while keeping background reads on display snapshots. */
export function useLiveGraph(context?: string, at?: number) {
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0), signature = useRef("");
  const accept = useCallback((graph: GraphData) => {
    const next = JSON.stringify([graph.nodes, graph.edges, graph.stats, graph.truncated]);
    if (next !== signature.current) { signature.current = next; setData(graph); }
    setError(null);
  }, []);
  const refresh = useCallback(() => {
    const current = generation.current;
    getGraph({ context, at }, true).then(graph => { if (current === generation.current) accept(graph); })
      .catch(reason => { if (current === generation.current) setError(reason.message); });
  }, [context, at, accept]);
  useEffect(() => {
    let cancelled = false, loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const graph = await getGraph({ context, at }, "snapshot");
        if (!cancelled) accept(graph);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally { loading = false; }
    }
    void load();
    const changed = () => { if (document.visibilityState === "visible") void load(); };
    const timer = setInterval(changed, 30_000);
    document.addEventListener("visibilitychange", changed);
    return () => { cancelled = true; generation.current++; clearInterval(timer); document.removeEventListener("visibilitychange", changed); };
  }, [context, at, accept]);
  return { data, error, refresh };
}
