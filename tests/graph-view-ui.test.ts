import { expect, it } from "bun:test";
import { chromium, type Page } from "playwright-core";
import type { GraphData, GraphNode } from "../visualizer/src/types";
import { createWebHost } from "./fixtures/web-host";

const node: GraphNode = {
  id: 1, name: "Single graph entry", type: "Note", namespace: "test", stableId: "test:1",
  canonicalId: null, degree: 1, chunksCount: 0, chunks: [],
};
const graph: GraphData = {
  nodes: [node], edges: [], truncated: false,
  stats: { totalEntities: 1, totalEdges: 0, totalSources: 0, totalChunks: 0, totalClaims: 0 },
};

async function openKnowledge(page: Page, base: string) {
  page.setDefaultTimeout(5000);
  await page.route(/\/knowledge-map-.*\.json$/, route => route.fulfill({ status: 404 }));
  await page.route(/\/api\/graph(?:\?|$)/, route => route.fulfill({ json: graph }));
  await page.goto(base);
  await page.getByRole("link", { name: "Knowledge", exact: true }).click();
  const canvas = page.getByRole("img", { name: /Knowledge graph map/ });
  await canvas.waitFor();
  return canvas;
}

async function waitCanvasAttribute(page: Page, attribute: string, value: string) {
  await page.waitForFunction(({ attribute, value }) => document.querySelector("canvas.graph-map")?.getAttribute(attribute) === value,
    { attribute, value }, { timeout: 5000 });
}

it.skipIf(process.env.SHALE_WEB_E2E !== "1")("preserves graph preferences and interactions across layouts, empty data, worker failure, and reduced motion", async () => {
  const host = createWebHost();
  const browser = await chromium.launch({ executablePath: process.env.SHALE_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const canvas = await openKnowledge(page, host.base);

    const organic = page.getByRole("button", { name: "Organic", exact: true });
    const classic = page.getByRole("button", { name: "Classic", exact: true });
    expect(await organic.getAttribute("aria-pressed")).toBe("true");
    expect(await classic.getAttribute("aria-pressed")).toBe("false");
    expect(await canvas.getAttribute("data-layout")).toBe("organic");
    expect(await canvas.getAttribute("data-node-count")).toBe("1");
    expect(await canvas.getAttribute("aria-busy")).toBe("false");

    const box = await canvas.boundingBox();
    if (!box) throw new Error("Graph canvas has no layout box");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByRole("heading", { name: "Single graph entry", exact: true }).waitFor();
    await page.getByLabel("Focus selection").check();
    await page.getByLabel("Connection depth").selectOption("3");

    // Pan over empty canvas space; the selected node remains selected. Reset before dragging it.
    await page.mouse.move(box.x + box.width * .25, box.y + box.height * .75);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .3, box.y + box.height * .78, { steps: 3 });
    await page.mouse.up();
    await page.getByRole("heading", { name: "Single graph entry", exact: true }).waitFor();
    await page.getByRole("button", { name: "Reset graph view" }).click();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 28, box.y + box.height / 2 + 18, { steps: 3 });
    await page.mouse.up();
    await page.getByRole("heading", { name: "Single graph entry", exact: true }).waitFor();

    await page.locator(".filter-options").getByLabel("Note").uncheck();
    // Focus mode keeps its selected node visible even after its type is hidden.
    expect(await canvas.getAttribute("data-node-count")).toBe("1");
    await page.getByLabel("Focus selection").uncheck();
    await waitCanvasAttribute(page, "data-node-count", "0");
    expect(await canvas.getAttribute("data-node-count")).toBe("0");
    await page.getByText("No entries match these filters.", { exact: true }).waitFor();
    await page.locator(".filter-options").getByLabel("Note").check();
    await waitCanvasAttribute(page, "data-node-count", "1");
    await page.getByLabel("Focus selection").check();
    expect(await canvas.getAttribute("data-node-count")).toBe("1");

    await page.getByRole("button", { name: "Zoom in" }).click();
    expect(await page.locator(".map-controls").innerText()).toContain("120%");
    await classic.click();
    await waitCanvasAttribute(page, "data-layout", "classic");
    expect(await page.getByRole("img", { name: /Knowledge graph map/ }).getAttribute("data-layout")).toBe("classic");
    expect(await page.getByRole("button", { name: "Classic", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect(await page.getByLabel("Connection depth").inputValue()).toBe("3");
    expect(await page.getByLabel("Focus selection").isChecked()).toBe(true);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.getByRole("button", { name: "Organic", exact: true }).click();
    await waitCanvasAttribute(page, "data-layout", "organic");
    expect(await page.locator(".map-controls").innerText()).toContain("120%");
    await page.reload();
    await page.getByRole("link", { name: "Knowledge", exact: true }).click();
    const reloadedCanvas = page.getByRole("img", { name: /Knowledge graph map/ });
    expect(await reloadedCanvas.getAttribute("data-layout")).toBe("organic");
    expect(await page.getByLabel("Repel force", { exact: true }).inputValue()).toBe("300");

    const forces = page.locator("details.graph-forces");
    await forces.locator("summary").click();
    const repel = page.getByLabel("Repel force", { exact: true });
    await repel.focus();
    for (let step = 0; step < 15; step++) await repel.press("ArrowRight");
    expect(await repel.inputValue()).toBe("450");
    await page.reload();
    await page.getByRole("link", { name: "Knowledge", exact: true }).click();
    await page.locator("details.graph-forces summary").click();
    expect(await page.getByLabel("Repel force", { exact: true }).inputValue()).toBe("450");
    await page.getByRole("button", { name: "Restore defaults", exact: true }).click();
    expect(await page.getByLabel("Repel force", { exact: true }).inputValue()).toBe("300");

    // Reload with Classic persisted, then verify that preference also survives a page load.
    await page.getByRole("button", { name: "Classic", exact: true }).click();
    await page.reload();
    await page.getByRole("link", { name: "Knowledge", exact: true }).click();
    expect(await page.getByRole("button", { name: "Classic", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect(await page.getByRole("img", { name: /Knowledge graph map/ }).getAttribute("data-layout")).toBe("classic");
    expect(errors).toEqual([]);

    const failedPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await failedPage.addInitScript(() => {
      Object.defineProperty(window, "Worker", { configurable: true, value: class { constructor() { throw new Error("worker unavailable"); } } });
    });
    await failedPage.route(/\/knowledge-map-.*\.json$/, route => route.fulfill({ status: 404 }));
    await failedPage.route(/\/api\/graph(?:\?|$)/, route => route.fulfill({ json: {
      ...graph, nodes: [node, { ...node, id: 2, name: "Second entry", stableId: "test:2" }],
      stats: { ...graph.stats, totalEntities: 2 },
    } }));
    await failedPage.goto(host.base);
    await failedPage.getByRole("link", { name: "Knowledge", exact: true }).click();
    await failedPage.getByRole("alert").filter({ hasText: "Switch to Classic" }).waitFor();
    await failedPage.getByRole("button", { name: "Classic", exact: true }).click();
    expect(await failedPage.getByRole("img", { name: /Knowledge graph map/ }).getAttribute("data-layout")).toBe("classic");
    await failedPage.close();

    const reducedPage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    await reducedPage.route(/\/knowledge-map-.*\.json$/, route => route.fulfill({ status: 404 }));
    await reducedPage.route(/\/api\/graph(?:\?|$)/, route => route.fulfill({ json: {
      ...graph, nodes: [node, { ...node, id: 2, name: "Second entry", stableId: "test:2" }],
      stats: { ...graph.stats, totalEntities: 2 },
    } }));
    await reducedPage.goto(host.base);
    await reducedPage.getByRole("link", { name: "Knowledge", exact: true }).click();
    const reducedCanvas = reducedPage.getByRole("img", { name: /Knowledge graph map/ });
    await reducedCanvas.waitFor();
    await reducedPage.waitForFunction(() => document.querySelector("canvas.graph-map")?.getAttribute("aria-busy") === "false", null, { timeout: 10_000 });
    await reducedPage.close();
  } finally { await browser.close(); host.close(); }
}, 60_000);
