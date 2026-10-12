import type { IncomingMessage } from "node:http";

/** MCP clients without an Origin are allowed; browsers must address the listener itself. */
export function acceptsRequestOrigin(req: IncomingMessage, hostname = "127.0.0.1"): boolean {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const hosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    if (hostname !== "0.0.0.0" && hostname !== "::") hosts.add(hostname);
    if (!hosts.has(url.hostname) || req.headers["sec-fetch-site"] === "cross-site") return false;
    const origin = req.headers.origin;
    return origin === undefined || origin === url.origin;
  } catch {
    return false;
  }
}
