import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { createExtensionSDK } from "../sdk";
import { getGraphData as buildGraphData } from "./graph-data";
import { enrichResults } from "./search-results";
import { knowledgeApi } from "./knowledge-api";
import { rejectNonLocalRequest } from "../main/local-request";
import type { ClaimFilter } from "../sdk/graph/types";

const sdk = createExtensionSDK("visualizer");
const distDir = join(import.meta.dir, "dist");

export { type GraphData } from "./graph-data";
export function getGraphData(sdkOverride = sdk, filter?: ClaimFilter) {
  return buildGraphData(sdkOverride,filter);
}

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
  });
}

async function search(req: Request, mode: "hybrid" | "vector" | "bm25", sdk = createExtensionSDK("visualizer")) {
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
    return json({ query, results: enrichResults(results, sdk.database) });
  } catch (error: any) {
    if (mode === "hybrid") {
      try {
        return json({ query, results: enrichResults(await sdk.search.bm25({ query, limit }), sdk.database), fallback: "bm25" });
      } catch {}
    }
    return json({ error: error?.message || "Search failed." }, 500);
  }
}

function staticFile(pathname: string): Response {
  if (pathname.startsWith("/api/")) return json({ error: "Unknown API endpoint." }, 404);
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

/** The daemon and the compatibility visualizer server share the same routes. */
export async function handleVisualizerRequest(req: Request, sdkOverride = sdk): Promise<Response> {
  const rejected = rejectNonLocalRequest(req);
  if (rejected) return rejected;
  try {
      const url = new URL(req.url);
      const { pathname } = url;
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });
      if (pathname === "/api/graph" && req.method === "GET") {
        const at=url.searchParams.has('at') ? Number(url.searchParams.get('at')) : undefined;
        if (at!==undefined && !Number.isSafeInteger(at)) return json({error:'Invalid graph date'},400);
        return json(getGraphData(sdkOverride,{at,context:url.searchParams.get('context') ?? undefined}));
      }
      const knowledgeResponse = await knowledgeApi(req,url,sdkOverride);
      if (knowledgeResponse) return knowledgeResponse;
      if (pathname === '/api/search/graph' && req.method === 'POST') {
        try {return json(await sdkOverride.search.graph(await req.json()));}
        catch (error) {return json({error:error instanceof Error ? error.message : 'Search failed'},400);}
      }
      const searchMatch = pathname.match(/^\/api\/search\/(hybrid|vector|bm25)$/);
      if (searchMatch && req.method === "POST") return search(req, searchMatch[1] as "hybrid" | "vector" | "bm25", sdkOverride);
      if (pathname === "/api/health") return json({ ok: true });
      return staticFile(pathname);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Request failed." }, 400);
  }
}

export function startVisualizerServer(port = 3333, sdkOverride = sdk) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: req => handleVisualizerRequest(req, sdkOverride),
  });
  console.log(`[Visualizer] React notebook available at http://localhost:${server.port}`);
  return server;
}

if (import.meta.main) {
  const { runWebHost } = await import("../scripts/start-web-host");
  await runWebHost();
}
