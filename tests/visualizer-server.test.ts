import { expect, it } from "bun:test";
import { networkInterfaces } from "node:os";
import { startVisualizerServer } from "../visualizer/server";

it("serves local clients while rejecting external origins, hostnames, and interfaces", async () => {
  const server = startVisualizerServer(0);
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const local = await fetch(`${base}/api/health`, { headers: { Origin: base } });
    expect(local.status).toBe(200);
    expect(local.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect((await fetch(`${base}/api/graph`, { headers: { Origin: "https://external.example" } })).status).toBe(403);
    expect((await fetch(`${base}/api/health`, { headers: { Host: "external.example", Origin: "http://external.example" } })).status).toBe(403);
    const address = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
    if (address) await expect(fetch(`http://${address}:${server.port}/api/health`, {
      signal: AbortSignal.timeout(500),
    })).rejects.toThrow();
  } finally { server.stop(true); }
});
