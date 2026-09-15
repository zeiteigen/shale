import type { GraphData, SearchMode, SearchResult } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function getGraph() {
  return request<GraphData>("/api/graph");
}

export function search(query: string, mode: SearchMode, limit = 12) {
  return request<{ results: SearchResult[] }>(`/api/search/${mode}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
  });
}
