import type { GraphData, SearchMode, SearchResult } from "./types";

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

const graphRequests=new Map<string,{promise:Promise<GraphData>;expires:number;pending:boolean}>();
export function getGraph(filter: {context?:string;at?:number} = {}, refresh: boolean | "snapshot" = false) {
  const query=new URLSearchParams();
  if (filter.context !== undefined) query.set('context',filter.context);
  if (filter.at !== undefined) query.set('at',String(filter.at));
  const path=`/api/graph?${query}`,cached=graphRequests.get(path);
  if(cached && (cached.pending || !refresh && cached.expires>Date.now()))return cached.promise;
  const entry={promise:Promise.resolve(null as unknown as GraphData),expires:0,pending:true};
  async function load() {
    if(refresh!==true && filter.context===undefined && filter.at===undefined) {
      try {
        const [graph,host]=await Promise.all([
          request<GraphData>(`/knowledge-map-${location.port || '80'}.json`,{cache:'no-store'}),
          request<{uptime:number}>('/api/host'),
        ]);
        const age=Date.now()-Date.parse(graph.generatedAt ?? '');
        const started=Date.now()-host.uptime*1000;
        if(age>=0 && age<45_000 && graph.hostStartedAt!==undefined && Math.abs(started-graph.hostStartedAt)<2500)return graph;
      } catch { /* Fall back when a snapshot is unavailable or belongs to another host. */ }
    }
    return request<GraphData>(path);
  }
  entry.promise=load().then(data=>{entry.pending=false;entry.expires=Date.now()+30_000;return data;},error=>{if(graphRequests.get(path)===entry)graphRequests.delete(path);throw error;});
  if(graphRequests.size>=8)graphRequests.delete(graphRequests.keys().next().value!);
  graphRequests.set(path,entry);return entry.promise;
}

export function updateKnowledge<T>(action: string, body: unknown) {
  return request<T>(`/api/knowledge/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
}

export function search(query: string, mode: SearchMode, limit = 12) {
  return request<{ results: SearchResult[] }>(`/api/search/${mode}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
  });
}
