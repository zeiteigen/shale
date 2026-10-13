import { expect, it } from "bun:test";
import { chromium } from "playwright-core";
import { createWebHost } from "./fixtures/web-host";
import type { GraphData, GraphNode } from "../visualizer/src/types";

const node = (id: number, name: string, type: string): GraphNode => ({
  id, name, type, namespace: "conversation-analysis", stableId: `test:${id}`, canonicalId: null,
  degree: 0, chunksCount: 0, chunks: [],
});
const graph = (nodes: GraphNode[]): GraphData => ({ nodes, edges: [], truncated: false,
  stats: { totalEntities: nodes.length, totalEdges: 0, totalSources: 0, totalChunks: 0, totalClaims: 0 } });

it.skipIf(process.env.SHALE_WEB_E2E !== "1")("finds source-free MCP entries and follows external graph updates without resetting hidden types", async () => {
  const host = createWebHost();
  const browser = await chromium.launch({ executablePath: process.env.SHALE_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(5000);
    await page.clock.install();
    let current = graph([node(1, "Existing note", "Note")]);
    await page.route(/\/knowledge-map-.*\.json$/, route => route.fulfill({ status: 404 }));
    await page.route(/\/api\/graph(?:\?|$)/, route => route.fulfill({ json: current }));
    await page.route(/\/api\/knowledge\/claims(?:\?|$)/, route => route.fulfill({ json: { claims: [] } }));
    await page.route(/\/api\/knowledge\/entity\?/, route => route.fulfill({ json: { aliases: [], merges: [] } }));
    await page.goto(`${host.base}/#knowledge`);
    await page.locator('.filter-options').getByLabel("Note").uncheck();
    current = graph([...current.nodes, node(2, "Winter 2027 first co-op search", "CareerSearch")]);
    await page.getByRole("button", { name: "Refresh map", exact: true }).click();
    await page.locator('.filter-options').getByLabel("CareerSearch").waitFor();
    expect(await page.locator('.filter-options').getByLabel("CareerSearch").isChecked()).toBe(true);
    expect(await page.locator('.filter-options').getByLabel("Note").isChecked()).toBe(false);
    await page.getByLabel("Search the notebook").fill("Winter 2027");
    await page.getByRole("button", { name: /Winter 2027 first co-op search/ }).click();
    await page.getByRole("heading", { name: "Winter 2027 first co-op search", exact: true }).waitFor();
    current = graph([...current.nodes, node(3, "ML research and scientific computing", "CareerInterest")]);
    await page.clock.runFor(31_000);
    await page.locator('.filter-options').getByLabel("CareerInterest").waitFor();
    expect(await page.locator('.filter-options').getByLabel("CareerInterest").isChecked()).toBe(true);
    expect(await page.locator('.filter-options').getByLabel("Note").isChecked()).toBe(false);
    expect(await page.getByRole("heading", { name: "Winter 2027 first co-op search", exact: true }).isVisible()).toBe(true);
  } finally { await browser.close(); host.close(); }
}, 30_000);
