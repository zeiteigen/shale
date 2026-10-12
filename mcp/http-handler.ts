import http from "node:http";
import { randomUUID } from "node:crypto";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createExtensionSDK, type ShaleSDK } from "../sdk";
import { createScopedSDK, type ScopedSDK } from "../sdk/access";
import { profileForRequest } from "../lib/access/tokens";
import { createKnowledgeGraphMcpServer } from "./server";

export interface McpHttpServerOptions {
  port?: number;
  host?: string;
  sdk?: ShaleSDK;
  namespace?: string;
  name?: string;
  version?: string;
  /** Serve every request as this access profile without a token (a listener dedicated to one profile). */
  profile?: string;
}

export interface RunningMcpServer {
  server: http.Server;
  port: number;
  host: string;
  url: string;
  close: () => Promise<void>;
}

export function createMcpHttpHandler(options: McpHttpServerOptions = {}) {
  const sseTransports = new Map<string, SSEServerTransport>();
  const sseAccess = new Map<string, ScopedSDK>();
  const streamableSessions = new Map<
    string,
    { mcp: ReturnType<typeof createKnowledgeGraphMcpServer>; transport: StreamableHTTPServerTransport; access: ScopedSDK }
  >();

  const serverName = options.name ?? "shale-knowledge-graph";
  const serverVersion = options.version ?? "1.0.0";
  let base: ShaleSDK | undefined;

  /** Each request names its profile by token; sessions stay bound to the profile that opened them. */
  function accessFor(req: http.IncomingMessage): ScopedSDK {
    const profile = options.profile ?? profileForRequest(req.headers.authorization);
    base ??= options.sdk ?? createExtensionSDK("mcp-server", { namespace: options.namespace ?? "knowledge" });
    const access = createScopedSDK(profile, base);
    access.refresh();
    return access;
  }

  /** A session must keep its profile, and a policy edit that changes how the profile is served ends it. */
  function sameAccess(session: ScopedSDK, current: ScopedSDK) {
    return session.profile.name === current.profile.name && session.read === current.read;
  }

  function createServerInstance(access: ScopedSDK) {
    return createKnowledgeGraphMcpServer({
      name: serverName,
      version: serverVersion,
      sdk: base,
      namespace: options.namespace,
      access,
    });
  }

  function reject(res: http.ServerResponse, status: number, message: string) {
    res.writeHead(status, { "Content-Type": "application/json", ...(status === 401 ? { "WWW-Authenticate": "Bearer" } : {}) });
    res.end(JSON.stringify({ error: message }));
  }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // Enable CORS for agent integration across different origins and browser extensions
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, mcp-session-id, last-event-id",
    );
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const host = req.headers.host || `localhost:${options.port || 7426}`;
    const protocol = "http";
    const url = new URL(req.url || "/", `${protocol}://${host}`);

    // Health check and root info
    if ((url.pathname === "/" || url.pathname === "/health") && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          {
            status: "ok",
            server: serverName,
            version: serverVersion,
            protocol: "mcp",
            transports: ["sse", "streamable-http"],
            endpoints: {
              sse: "/sse",
              messages: "/messages",
              streamableHttp: "/mcp",
              health: "/health",
            },
            activeSessions: {
              sse: sseTransports.size,
              streamable: streamableSessions.size,
            },
          },
          null,
          2,
        ),
      );
      return;
    }

    const isMcpEndpoint = url.pathname === "/sse" || url.pathname === "/messages" || url.pathname === "/mcp";
    let access: ScopedSDK | undefined;
    if (isMcpEndpoint) {
      try {
        access = accessFor(req);
      } catch (err: any) {
        reject(res, err?.status ?? 500, err?.message || "Access denied");
        return;
      }
    }

    // 1. SSE Transport: GET /sse
    if (url.pathname === "/sse" && req.method === "GET") {
      try {
        const mcp = createServerInstance(access!);
        const transport = new SSEServerTransport("/messages", res);
        sseTransports.set(transport.sessionId, transport);
        sseAccess.set(transport.sessionId, access!);

        transport.onclose = () => {
          sseTransports.delete(transport.sessionId);
          sseAccess.delete(transport.sessionId);
        };

        await mcp.connect(transport);
      } catch (err: any) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err?.message || "Failed to establish SSE stream" }));
        }
      }
      return;
    }

    // 1. SSE Transport: POST /messages
    if (url.pathname === "/messages" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing sessionId parameter" }));
        return;
      }

      const transport = sseTransports.get(sessionId);
      if (!transport) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Session not found: ${sessionId}` }));
        return;
      }
      if (!sameAccess(sseAccess.get(sessionId)!, access!)) {
        reject(res, 403, "This session belongs to a different access profile, or the profile changed; reconnect");
        return;
      }

      await transport.handlePostMessage(req, res);
      return;
    }

    // 2. Streamable HTTP Transport: /mcp
    if (url.pathname === "/mcp") {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId =
        (Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader) ||
        url.searchParams.get("sessionId") ||
        undefined;

      let session = sessionId ? streamableSessions.get(sessionId) : undefined;
      let isNew = false;
      if (session && !sameAccess(session.access, access!)) {
        reject(res, 403, "This session belongs to a different access profile, or the profile changed; reconnect");
        return;
      }

      if (!session) {
        const mcp = createServerInstance(access!);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        await mcp.connect(transport);
        session = { mcp, transport, access: access! };
        isNew = true;
      }

      await session.transport.handleRequest(req, res);

      if (isNew && session.transport.sessionId) {
        streamableSessions.set(session.transport.sessionId, session);
        session.transport.onclose = () => {
          if (session?.transport.sessionId) {
            streamableSessions.delete(session.transport.sessionId);
          }
        };
      }
      return;
    }

    // Unhandled endpoint
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Endpoint not found: ${url.pathname}` }));
  };

  const closeAllSessions = async () => {
    for (const transport of sseTransports.values()) {
      try {
        await transport.close();
      } catch {}
    }
    sseTransports.clear();

    for (const session of streamableSessions.values()) {
      try {
        await session.transport.close();
      } catch {}
    }
    streamableSessions.clear();
  };

  return { handler, closeAllSessions, sseTransports, streamableSessions };
}

/**
 * Start the MCP Knowledge Graph HTTP Server.
 */
export async function startMcpServer(options: McpHttpServerOptions = {}): Promise<RunningMcpServer> {
  const { handler, closeAllSessions } = createMcpHttpHandler(options);

  const server = http.createServer(handler);
  const host = options.host || "127.0.0.1";
  const requestedPort = options.port !== undefined ? options.port : 7426;

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : requestedPort;
  const url = `http://${host}:${actualPort}`;

  const close = async () => {
    await closeAllSessions();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return {
    server,
    port: actualPort,
    host,
    url,
    close,
  };
}
