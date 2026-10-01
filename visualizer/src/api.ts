import type { GraphData, SearchMode, SearchResult } from "./types";

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function getGraph(filter: {context?:string;at?:number} = {}) {
  const query=new URLSearchParams();
  if (filter.context !== undefined) query.set('context',filter.context);
  if (filter.at !== undefined) query.set('at',String(filter.at));
  return request<GraphData>(`/api/graph?${query}`);
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
