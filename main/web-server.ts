import { createWebApi, type WebContext } from "./web-api";
import { rejectNonLocalRequest } from "./local-request";
import { handleVisualizerRequest } from "../visualizer/server";

interface ConnectorRoutes {
  health: () => Response;
  connectors: () => Response;
  connector: (req: Request) => Response | Promise<Response>;
  ingest: (req: Request) => Response | Promise<Response>;
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
      const rejected = rejectNonLocalRequest(req);
      if (rejected) return rejected;
      return await webApi(req, url) ?? handleVisualizerRequest(req);
    },
  });
}
