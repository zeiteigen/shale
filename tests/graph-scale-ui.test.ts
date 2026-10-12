import { expect, it } from 'bun:test';
import { chromium, type Page } from 'playwright-core';
import type { GraphData, GraphNode } from '../visualizer/src/types';
import { createWebHost } from './fixtures/web-host';

function graphFixture(count: number, clusterSize: number, orphans = 0): GraphData {
  const nodes: GraphNode[] = Array.from({ length: count + orphans }, (_, index) => ({
    id: index + 1, name: index < count ? `Cluster ${Math.floor(index / clusterSize) + 1} · Entry ${index % clusterSize + 1}` : `Isolated entry ${index - count + 1}`,
    type: index % clusterSize === 0 && index < count ? 'Topic' : 'Note', degree: index < count ? 4 : 0,
    namespace: 'test', stableId: `test:${index + 1}`, canonicalId: null, chunksCount: 0, chunks: [],
  }));
  const edges = nodes.slice(0, count).flatMap((node, index) => [1, Math.min(7, clusterSize - 2)].map((offset, link) => ({
    id: `${node.id}:${link}`, source: node.id, target: Math.floor(index / clusterSize) * clusterSize + (index + offset) % clusterSize + 1,
    relation: 'RELATED_TO', status: link ? 'proposed' : 'accepted', weight: 1,
  })));
  return { nodes, edges, truncated: false, stats: { totalEntities: nodes.length, totalEdges: edges.length, totalSources: 0, totalChunks: 0, totalClaims: edges.length } };
}

async function routes(page: Page, graph: GraphData) {
  await page.route(/\/knowledge-map-.*\.json$/, route => route.fulfill({ status: 404 }));
  await page.route(/\/api\/graph(?:\?|$)/, route => route.fulfill({ json: graph }));
  await page.route(/\/api\/knowledge\/claims(?:\?|$)/, route => route.fulfill({ json: { claims: [] } }));
  await page.route(/\/api\/knowledge\/entity\?/, route => route.fulfill({ json: { aliases: [], merges: [] } }));
}

const enabled = process.env.SHALE_WEB_E2E === '1';
it.skipIf(!enabled)('renders organic clusters and preserves focus and selection across graph views', async () => {
  const host = createWebHost(), browser = await chromium.launch({ executablePath: process.env.SHALE_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    // Observe the selected Topic's painted ring, without exposing test state in the app.
    await page.addInitScript(() => {
      const arc = CanvasRenderingContext2D.prototype.arc;
      CanvasRenderingContext2D.prototype.arc = function(x, y, radius, start, end, counterclockwise) {
        if (this.canvas.dataset.layout === 'organic' && this.strokeStyle === '#a54d69') {
          const t = this.getTransform(), dpr = this.canvas.width / this.canvas.clientWidth;
          Reflect.set(window, 'selectedGraphPoint', { x: (t.a * x + t.e) / dpr, y: (t.d * y + t.f) / dpr, offsetX: t.e / dpr, offsetY: t.f / dpr });
        }
        return arc.call(this, x, y, radius, start, end, counterclockwise);
      };
    });
    await routes(page, graphFixture(24, 8, 8));
    await page.goto(`${host.base}/#knowledge`);
    const map = page.getByRole('img', { name: /Knowledge graph map/ });
    await page.waitForFunction(() => document.querySelector('canvas.graph-map')?.getAttribute('aria-busy') === 'false');
    expect(await map.getAttribute('data-node-count')).toBe('32');
    if (process.env.SHALE_GRAPH_SCREENSHOT) await page.screenshot({ path: `${process.env.SHALE_GRAPH_SCREENSHOT}-organic.png` });
    await map.press('ArrowRight');
    await page.getByRole('heading', { name: 'Cluster 1 · Entry 1', exact: true }).waitFor();
    expect(await map.getAttribute('aria-busy')).toBe('false'); // Selection highlights without restarting physics.
    await page.waitForFunction(() => Boolean(Reflect.get(window, 'selectedGraphPoint')));
    const selectedPoint = await page.evaluate(() => Reflect.get(window, 'selectedGraphPoint') as { x: number; y: number; offsetX: number; offsetY: number });
    const canvasBox = (await map.boundingBox())!;
    await page.mouse.move(canvasBox.x + selectedPoint.x, canvasBox.y + selectedPoint.y);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + selectedPoint.x + 40, canvasBox.y + selectedPoint.y + 20, { steps: 3 });
    await page.waitForFunction(before => {
      const point = Reflect.get(window, 'selectedGraphPoint');
      return point.x > before.x + 35 && point.y > before.y + 15;
    }, selectedPoint);
    const duringDrag = await page.evaluate(() => Reflect.get(window, 'selectedGraphPoint'));
    expect(duringDrag.offsetX).toBe(selectedPoint.offsetX);
    expect(duringDrag.offsetY).toBe(selectedPoint.offsetY); // Dragging a node does not pan the camera.
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('canvas.graph-map')?.getAttribute('aria-busy') === 'false');
    await page.getByRole('button', { name: 'Focus on map', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('canvas.graph-map')?.getAttribute('aria-busy') === 'false');
    expect(await map.getAttribute('data-node-count')).toBe('5');
    await page.getByRole('button', { name: 'Classic', exact: true }).click();
    expect(await map.getAttribute('data-node-count')).toBe('5');
    expect(await page.getByRole('heading', { name: 'Cluster 1 · Entry 1', exact: true }).isVisible()).toBe(true);
    await page.getByLabel('Connection depth').selectOption('3');
    expect(await map.getAttribute('data-node-count')).toBe('8');
    await page.getByRole('button', { name: 'Organic', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('canvas.graph-map')?.getAttribute('aria-busy') === 'false');
    expect(await map.getAttribute('data-node-count')).toBe('8');
    await page.getByLabel('Focus selection', { exact: true }).uncheck();
    await page.locator('.filter-options').getByLabel('Note').uncheck();
    await page.locator('.filter-options').getByLabel('Topic').uncheck();
    await page.locator('.filter-options').getByLabel('Note').check();
    await page.locator('.filter-options').getByLabel('Topic').check();
    await page.waitForFunction(() => document.querySelector('canvas.graph-map')?.getAttribute('aria-busy') === 'false');
    expect(await map.getAttribute('data-node-count')).toBe('32');
    await page.getByRole('button', { name: 'Close reading pane' }).click();
    await page.getByRole('button', { name: 'Classic', exact: true }).click();
    await page.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-layout="classic"]');
      if (!canvas?.width || !canvas.height) return false;
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) return true;
      return false;
    });
    if (process.env.SHALE_GRAPH_SCREENSHOT) await page.screenshot({ path: `${process.env.SHALE_GRAPH_SCREENSHOT}-classic.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Organic', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('canvas.graph-map')?.getAttribute('aria-busy') === 'false');
    await page.getByRole('button', { name: 'Reset graph view' }).click();
    await page.locator('.graph-forces summary').click();
    expect(await page.getByLabel('Repel force', { exact: true }).isVisible()).toBe(true);
    const controlBox = await page.getByRole('button', { name: 'Zoom in', exact: true }).boundingBox();
    expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.SHALE_GRAPH_SCREENSHOT) await page.screenshot({ path: `${process.env.SHALE_GRAPH_SCREENSHOT}-mobile.png` });
    expect(errors).toEqual([]);
  } finally { await browser.close(); host.close(); }
}, 30_000);

it.skipIf(!enabled)('keeps a 5000-node, 10000-link graph responsive and cleans up its worker', async () => {
  const host = createWebHost(), browser = await chromium.launch({ executablePath: process.env.SHALE_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const metrics = { active: 0, snapshots: 0 }; Reflect.set(window, 'graphWorkerMetrics', metrics);
      const OriginalWorker = window.Worker;
      window.Worker = class extends OriginalWorker {
        terminated = false;
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options); metrics.active++;
          this.addEventListener('message', () => metrics.snapshots++);
        }
        terminate() { if (!this.terminated) { this.terminated = true; metrics.active--; } super.terminate(); }
      };
    });
    await routes(page, graphFixture(5000, 100));
    await page.goto(`${host.base}/#knowledge`);
    const map = page.getByRole('img', { name: /Knowledge graph map/ }); await map.waitFor();
    expect(await map.getAttribute('data-node-count')).toBe('5000');
    const zoom = page.locator('.map-controls span'), before = await zoom.textContent();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click({ timeout: 5000 });
    expect(await zoom.textContent()).not.toBe(before);
    await page.waitForFunction(() => document.querySelector('canvas.graph-map')?.getAttribute('aria-busy') === 'false', undefined, { timeout: 45_000 });
    await page.getByRole('button', { name: 'Reset graph view' }).click();
    expect(await map.getAttribute('data-node-count')).toBe('5000');
    await page.getByRole('button', { name: 'Classic', exact: true }).click();
    expect(await page.evaluate(() => Reflect.get(window, 'graphWorkerMetrics').active)).toBe(0);
    expect(await map.getAttribute('data-node-count')).toBe('5000');
    expect(errors).toEqual([]);
  } finally { await browser.close(); host.close(); }
}, 60_000);
