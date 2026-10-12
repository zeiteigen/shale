import { createWebApi, type WebContext } from "./web-api";
import { rejectNonLocalRequest } from "./local-request";
import { handleVisualizerRequest } from "../visualizer/server";

export interface ConnectorRoutes {
  health: () => Response;
  connectors: () => Response;
  connector: (req: Request) => Response | Promise<Response>;
  ingest: (req: Request) => Response | Promise<Response>;
  mcpUrl?: () => string | undefined;
}

/** Serve host controls and the notebook alongside the existing connector contract. */
export function startWebServer(context: WebContext, connectors: ConnectorRoutes, port: number) {
  const webApi = createWebApi(context);
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return connectors.health();
      if (url.pathname === "/connectors") return connectors.connectors();
      if (url.pathname.startsWith("/connectors/")) return connectors.connector(req);
      if (url.pathname === "/ingest") return connectors.ingest(req);

      const mcpBase = connectors.mcpUrl?.();
      if (
        mcpBase &&
        (url.pathname === "/mcp" ||
          url.pathname === "/sse" ||
          url.pathname === "/messages" ||
          url.pathname === "/mcp/health")
      ) {
        const rejected = rejectNonLocalRequest(req);
        if (rejected) return rejected;
        const targetPath = url.pathname === "/mcp/health" ? "/health" : url.pathname;
        const targetUrl = new URL(targetPath + url.search, mcpBase);
        const headers = new Headers(req.headers);
        headers.set("host", new URL(mcpBase).host);
        // The gateway has checked this origin; the backend has a different local port.
        headers.delete("origin");
        return fetch(targetUrl.toString(), {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
          // @ts-ignore
          duplex: "half",
        });
      }

      const rejected = rejectNonLocalRequest(req);
      if (rejected) return rejected;
      return (await webApi(req, url)) ?? handleVisualizerRequest(req);
    },
  });
}
