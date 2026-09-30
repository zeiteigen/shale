import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { createExtensionSDK, type ChunkSearchResult } from "../sdk";

const sdk = createExtensionSDK("visualizer");
const db = sdk.database;
const distDir = join(import.meta.dir, "dist");

function graphIdentityFromSourceUri(uri: string): string {
  if (uri.startsWith("browser-history:")) return uri.slice("browser-history:".length);
  if (uri.startsWith("browser-bookmark:")) {
    const urlStart = uri.search(/:https?:\/\//);
    if (urlStart >= 0) return uri.slice(urlStart + 1);
  }
  return uri;
}

export interface GraphData {
  nodes: Array<{
    id: number;
    name: string;
    type: string;
    namespace: string;
    degree: number;
    sourceUri?: string;
    sourceTitle?: string;
    chunksCount: number;
    chunks: Array<{ id: number; chunk_index: number; text_content: string }>;
  }>;
  edges: Array<{ source: number; target: number; relation: string; weight: number }>;
  stats: { totalEntities: number; totalEdges: number; totalSources: number; totalChunks: number };
}

export function getGraphData(): GraphData {
  const entities = db.query<{ id: number; namespace: string; name: string; type: string }, []>(
    "SELECT id, namespace, name, type FROM entities ORDER BY id ASC",
  ).all();
  const edges = db.query<{
    source_entity_id: number;
    target_entity_id: number;
    relation: string;
    weight: number;
  }, []>("SELECT source_entity_id, target_entity_id, relation, weight FROM edges").all();
  const sources = db.query<{ id: string; uri: string; title: string }, []>(
    "SELECT id, uri, title FROM sources",
  ).all();
  const sourceByTitle = new Map(sources.map((source) => [source.title.toLowerCase(), source]));
  const sourceByUri = new Map<string, (typeof sources)[number]>();
  for (const source of sources) {
    const identity = graphIdentityFromSourceUri(source.uri);
    // Rich web-page sources are queried first and remain the preferred material
    // when history/bookmark metadata points at the same page node.
    if (!sourceByUri.has(identity) || /^https?:\/\//.test(source.uri)) {
      sourceByUri.set(identity, source);
    }
  }
  const degree = new Map<number, number>();

  for (const edge of edges) {
    degree.set(edge.source_entity_id, (degree.get(edge.source_entity_id) || 0) + 1);
    degree.set(edge.target_entity_id, (degree.get(edge.target_entity_id) || 0) + 1);
  }

  return {
    nodes: entities.map((entity) => {
      const source = sourceByUri.get(entity.name) ?? sourceByTitle.get(entity.name.toLowerCase());
      const chunks = source ? sdk.context.getRecentChunks(source.id, 5) : [];
      return {
        ...entity,
        degree: degree.get(entity.id) || 0,
        sourceUri: source?.uri,
        sourceTitle: source?.title,
        chunksCount: chunks.length,
        chunks,
      };
    }),
    edges: edges.map((edge) => ({
      source: edge.source_entity_id,
      target: edge.target_entity_id,
      relation: edge.relation,
      weight: edge.weight,
    })),
    stats: {
      totalEntities: entities.length,
      totalEdges: edges.length,
      totalSources: db.query<{ count: number }, []>("SELECT count(*) AS count FROM sources").get()?.count || 0,
      totalChunks: db.query<{ count: number }, []>("SELECT count(*) AS count FROM chunks").get()?.count || 0,
    },
  };
}

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

function enrichResults(results: ChunkSearchResult[]) {
  const entityBySource = db.query<{ id: number }, { $uri: string; $title: string }>(
    "SELECT id FROM entities WHERE name = $uri OR lower(name) = lower($title) ORDER BY name = $uri DESC LIMIT 1",
  );
  return results.map((result) => ({
    ...result,
    entity_id: result.source_title
      ? entityBySource.get({
          $uri: graphIdentityFromSourceUri(result.source_uri ?? ""),
          $title: result.source_title,
        })?.id
      : undefined,
    preview: result.preview || result.text_content.slice(0, 280),
  }));
}

async function search(req: Request, mode: "hybrid" | "vector" | "bm25") {
  const body = (await req.json()) as { query?: string; limit?: number };
  const query = body.query?.trim();
  if (!query) return json({ error: "A query is required." }, 400);
  const limit = Math.max(1, Math.min(30, Number(body.limit) || 12));

  try {
    const results = mode === "vector"
      ? await sdk.search.vector({ query, limit })
      : mode === "bm25"
        ? await sdk.search.bm25({ query, limit })
        : await sdk.search.hybrid({ query, limit });
    return json({ query, results: enrichResults(results) });
  } catch (error: any) {
    if (mode === "hybrid") {
      try {
        return json({ query, results: enrichResults(await sdk.search.bm25({ query, limit })), fallback: "bm25" });
      } catch {}
    }
    return json({ error: error?.message || "Search failed." }, 500);
  }
}

function staticFile(pathname: string): Response {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = normalize(join(distDir, relativePath));
  const isWithinDist = candidate === distDir || candidate.startsWith(`${distDir}/`);
  const filePath = isWithinDist && existsSync(candidate)
    ? candidate
    : join(distDir, "index.html");

  if (!existsSync(filePath)) {
    return new Response("Build the React visualizer first: cd visualizer && bun run build", { status: 503 });
  }
  return new Response(Bun.file(filePath));
}

export function startVisualizerServer(port = Number(process.env.VISUALIZER_PORT) || 3333) {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": "*" } });
      if (pathname === "/api/graph" && req.method === "GET") return json(getGraphData());
      const searchMatch = pathname.match(/^\/api\/search\/(hybrid|vector|bm25)$/);
      if (searchMatch && req.method === "POST") return search(req, searchMatch[1] as "hybrid" | "vector" | "bm25");
      if (pathname === "/api/health") return json({ ok: true });
      return staticFile(pathname);
    },
  });
  console.log(`[Visualizer] React notebook available at http://localhost:${server.port}`);
  return server;
}

if (import.meta.main) startVisualizerServer();
