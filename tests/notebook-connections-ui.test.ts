import { expect, it } from "bun:test";
import { chromium } from "playwright-core";
import type { GraphData, GraphNode } from "../visualizer/src/types";
import { createWebHost } from "./fixtures/web-host";

// Run against the built UI with the other browser checks.
it.skipIf(process.env.SHALE_WEB_E2E !== "1")("clears repeated connections when selecting a different graph entry", async () => {
  const node = (id: number, name: string, type: string, degree: number): GraphNode => ({
    id, name, type, degree, namespace: type === "WebSession" || type === "WebPage" ? "browser" : "obsidian",
    stableId: `test:${id}`, canonicalId: null, chunksCount: 0, chunks: [],
  });
  const edge = (id: string, source: number, target: number, relation: string) => ({
    id, source, target, relation, status: "accepted", weight: 1,
  });
  const graph: GraphData = {
    nodes: [
      node(1, "Browsing session", "WebSession", 5),
      node(2, "polar-coordinates", "Tag", 1),
      node(3, "Polar Coordinates Guide", "Note", 1),
      node(4, "Course Home", "WebPage", 2),
      node(5, "Kiro Web Portal", "WebPage", 2),
      node(6, "www.tradingview.com", "Domain", 1),
    ],
    edges: [
      edge("visit-1", 1, 4, "CONTAINS_PAGE"),
      edge("visit-2", 1, 4, "CONTAINS_PAGE"),
      edge("visit-3", 1, 5, "CONTAINS_PAGE"),
      edge("visit-4", 1, 5, "CONTAINS_PAGE"),
      edge("domain", 1, 6, "BELONGS_TO_DOMAIN"),
      edge("tag", 3, 2, "HAS_TAG"),
    ],
    truncated: false,
    stats: { totalEntities: 6, totalEdges: 6, totalSources: 0, totalChunks: 0, totalClaims: 6 },
  };
  const host = createWebHost();
  const browser = await chromium.launch({
    executablePath: process.env.SHALE_CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true, args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(5000);
    await page.route(/\/knowledge-map-.*\.json$/, route => route.fulfill({ status: 404 }));
    await page.route(/\/api\/graph(?:\?|$)/, route => route.fulfill({ json: graph }));
    await page.route(/\/api\/knowledge\/claims$/, route => route.fulfill({ json: { claims: [] } }));
    await page.route(/\/api\/knowledge\/entity\?/, route => route.fulfill({ json: { aliases: [], merges: [] } }));
    await page.goto(host.base);
    await page.getByRole("link", { name: "Knowledge", exact: true }).click();
    const map = page.getByRole("img", { name: /Knowledge graph map/ });
    await map.waitFor();
    const connections = page.locator(".reading-pane .connection");
    for (let cycle = 0; cycle < 3; cycle++) {
      await map.press("ArrowRight");
      await page.getByRole("heading", { name: "Browsing session", exact: true }).waitFor();
      expect(await connections.count()).toBe(3);
      await map.press("ArrowRight");
      await page.getByRole("heading", { name: "polar-coordinates", exact: true }).waitFor();
      if (cycle === 0 && process.env.SHALE_CONNECTIONS_SCREENSHOT)
        await page.screenshot({ path: process.env.SHALE_CONNECTIONS_SCREENSHOT, fullPage: true });
      expect(await connections.locator("strong").allTextContents()).toEqual(["Polar Coordinates Guide"]);
      await map.press("ArrowLeft");
      await page.getByRole("heading", { name: "Browsing session", exact: true }).waitFor();
      expect(await connections.count()).toBe(3);
      // Close the panel to begin the next selection cycle at the first node.
      await page.getByRole("button", { name: "Close reading pane" }).click();
    }
  } finally { await browser.close(); host.close(); }
}, 30_000);
