import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { createExtensionSDK, type ChunkSearchResult } from "../sdk";
import { getGraphData as buildGraphData } from "./graph-data";
import { sourceEntityName, graphIdentityFromSourceUri } from "../lib/source-identity";

const sdk = createExtensionSDK("visualizer");
const db = sdk.database;
const distDir = join(import.meta.dir, "dist");

export { type GraphData } from "./graph-data";
export function getGraphData(sdkOverride = sdk) {
  return buildGraphData(sdkOverride);
}

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
  });
}

function enrichResults(results: ChunkSearchResult[]) {
  const entityBySource = db.query<{ id: number }, { $uri: string; $title: string; $identity: string }>(
    `SELECT id FROM entities WHERE name = $identity OR name = $uri
      OR (lower(name) = lower($title) AND (SELECT count(*) FROM sources WHERE lower(title) = lower($title)) = 1)
      ORDER BY name = $identity DESC, name = $uri DESC LIMIT 1`,
  );
  return results.map((result) => ({
    ...result,
    entity_id: result.source_title
      ? entityBySource.get({
          $identity: sourceEntityName(result.source_id),
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
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;
      if (!["127.0.0.1", "localhost"].includes(url.hostname))
        return json({ error: "Only local hosts are allowed." }, 403);
      const origin = req.headers.get("Origin");
      if (origin && origin !== new URL(req.url).origin)
        return json({ error: "Cross-origin requests are not allowed." }, 403);
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });
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
