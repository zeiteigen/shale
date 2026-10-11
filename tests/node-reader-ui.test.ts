import { expect, it } from "bun:test";
import { chromium } from "playwright-core";
import type { Claim } from "../sdk/graph/types";
import type { GraphData, GraphNode, SourceMemory } from "../visualizer/src/types";
import { createWebHost } from "./fixtures/web-host";

type ClaimInspection = {
  claim: Claim; evidence: []; dependencies: string[]; dependents: string[];
  reviews: []; history: []; links: [];
};

it.skipIf(process.env.SHALE_WEB_E2E !== "1")("shows retained source memory on demand in the node reader", async () => {
  const node = (id: number, name: string, type: string, degree: number, sourceId?: string): GraphNode => ({
    id, name, type, degree, namespace: "obsidian", stableId: `test:${id}`, canonicalId: null,
    chunksCount: 0, chunks: [], ...(sourceId ? { sourceId } : {}),
  });
  const edge = (id: string, source: number, target: number, relation: string) => ({
    id, source, target, relation, status: "accepted", weight: 1,
  });
  const graph: GraphData = {
    nodes: [
      node(1, "Polar Coordinates Guide", "Note", 4, "source-polar"),
      node(2, "polar-coordinates", "Tag", 1),
      node(3, "Course Home", "WebPage", 1),
      node(4, "Kiro Web Portal", "WebPage", 1),
      node(5, "Linear Algebra", "Note", 1),
    ],
    edges: [
      edge("tag-1", 1, 2, "HAS_TAG"), edge("tag-2", 1, 2, "HAS_TAG"),
      edge("page-1", 1, 3, "REFERENCES"), edge("page-2", 1, 3, "REFERENCES"),
      edge("portal", 1, 4, "REFERENCES"), edge("related", 1, 5, "RELATED_TO"),
    ],
    truncated: false,
    stats: { totalEntities: 5, totalEdges: 6, totalSources: 1, totalChunks: 0, totalClaims: 16 },
  };
  const longExcerpt = "Quoted source passage: " + "The radius and angle determine a point in the plane. ".repeat(18);
  const observedAt = Date.UTC(2026, 9, 10, 12);
  const memory: SourceMemory = {
    source: { id: "source-polar", uri: "file:///notes/polar.md", title: "Polar Coordinates Guide", type: "note", origin: "obsidian", updated_at: observedAt },
    version: 7,
    summary: { text: "A concise retained summary about converting between Cartesian and polar coordinates.", versionId: 7, method: "model" },
    snippets: [
      { id: "snippet-1", versionId: 7, text: longExcerpt, kind: "excerpt", locator: { heading: "Worked example" }, purpose: "supports coordinate conversion" },
      { id: "snippet-2", versionId: 7, text: "The guide also links angle conventions to trigonometry.", kind: "derived", locator: { heading: "Angles" }, purpose: "topic note" },
    ],
    freshness: { fingerprint: "fp-7", lastObservedAt: observedAt, observation: null },
    coverage: { inputCharacters: 1200, sections: 2, summarizedSections: 2, method: "model" },
    availability: "retained", completeOriginal: false,
  };
  const claims: Claim[] = Array.from({ length: 16 }, (_, index) => ({
    id: `claim-${index + 1}`, subject: 1, predicate: "EXPLAINS", value: `Raw claim payload ${index + 1}`,
    namespace: "obsidian", status: "accepted", recordedAt: observedAt, confidence: 0.8,
  }));
  const memoryRequests: string[] = [];
  const claimRequests: Array<{ statuses: string[]; excludePredicates: string[] }> = [];
  const reviews: unknown[] = [];
  const host = createWebHost();
  const browser = await chromium.launch({ executablePath: process.env.SHALE_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route(/\/knowledge-map-.*\.json$/, route => route.fulfill({ status: 404 }));
    await page.route(/\/api\/graph(?:\?|$)/, route => route.fulfill({ json: graph }));
    await page.route(/\/api\/knowledge\/claims(?:\?|$)/, async route => {
      const body = route.request().postDataJSON() as { offset?: number; limit?: number };
      claimRequests.push(route.request().postDataJSON());
      await route.fulfill({ json: { claims: claims.slice(body.offset ?? 0, (body.offset ?? 0) + (body.limit ?? 13)) } });
    });
    await page.route(/\/api\/knowledge\/inspect\?/, async route => {
      const claim = claims.find(item => item.id === new URL(route.request().url()).searchParams.get("id"))!;
      const detail: ClaimInspection = { claim, evidence: [], dependencies: [], dependents: [], reviews: [], history: [], links: [] };
      await route.fulfill({ json: detail });
    });
    await page.route(/\/api\/knowledge\/entity\?/, route => route.fulfill({ json: { aliases: [], merges: [] } }));
    await page.route(/\/api\/knowledge\/review$/, async route => {
      reviews.push(route.request().postDataJSON());
      await route.fulfill({ json: { success: true } });
    });
    await page.route(/\/api\/knowledge\/memory\?/, async route => {
      memoryRequests.push(new URL(route.request().url()).searchParams.get("sourceId") ?? "");
      await route.fulfill({ json: memory });
    });

    await page.goto(host.base);
    await page.getByRole("link", { name: "Knowledge", exact: true }).click();
    const map = page.getByRole("img", { name: /Knowledge graph map/ });
    await map.waitFor();
    await map.press("ArrowRight");
    const pane = page.locator(".reading-pane");
    await pane.getByRole("heading", { name: "Polar Coordinates Guide", exact: true }).waitFor();
    const tabs = pane.getByRole("tab");
    expect(await tabs.allTextContents()).toEqual(["Overview", "Snippets", "Connections", "Claims", "Details"]);
    expect(await tabs.filter({ hasText: "Overview" }).getAttribute("aria-selected")).toBe("true");
    await pane.getByText(memory.summary.text).waitFor();
    expect(await pane.getByText("Model summary", { exact: true }).isVisible()).toBe(true);
    expect(new Set(memoryRequests)).toEqual(new Set(["source-polar"]));
    expect(await pane.locator(".claim-card").count()).toBe(0);
    expect(await pane.getByText(/Raw claim payload/).count()).toBe(0);

    await tabs.filter({ hasText: "Snippets" }).click();
    expect(await pane.getByLabel("Filter snippets").isVisible()).toBe(true);
    const excerpt = pane.locator("details").filter({ hasText: "Quoted excerpt" });
    expect(await excerpt.isVisible()).toBe(true);
    await excerpt.locator("summary").click();
    expect(await excerpt.locator('.snippet-body p').isVisible()).toBe(true);
    expect(await excerpt.locator('.snippet-body p').textContent()).toBe(longExcerpt);
    expect(await pane.getByText("Derived note", { exact: true }).isVisible()).toBe(true);

    await tabs.filter({ hasText: "Connections" }).click();
    const groups = pane.locator(".connection");
    expect(await groups.count()).toBe(4);
    const tagGroup = groups.filter({ has: page.locator("strong", { hasText: "polar-coordinates" }) });
    expect(await tagGroup.innerText()).toMatch(/2/);
    expect(await pane.getByLabel("Filter connections").isVisible()).toBe(true);

    await tabs.filter({ hasText: "Claims" }).click();
    const claimCards = pane.locator(".claim-card");
    await claimCards.first().waitFor();
    expect(await pane.getByLabel("Claim status").inputValue()).toBe("active");
    expect(await claimCards.count()).toBe(12);
    expect(claimRequests.at(-1)?.statuses).toEqual(['accepted', 'proposed', 'disputed', 'stale']);
    expect(claimRequests.at(-1)?.excludePredicates).toContain('SOURCE_URI');
    expect(await pane.getByText("Raw claim payload 1", { exact: true }).count()).toBe(1);
    await pane.getByRole("button", { name: /Next/ }).click();
    await pane.getByText("Raw claim payload 13", { exact: true }).waitFor();
    expect(await claimCards.count()).toBe(4);
    expect(await pane.getByText("Raw claim payload 1", { exact: true }).count()).toBe(0);

    await claimCards.first().click();
    await pane.getByRole('heading', { name: 'Evidence', exact: true }).waitFor();
    const review = pane.locator('details').filter({ hasText: 'Review this claim' });
    expect(await review.getAttribute('open')).toBeNull();
    expect(reviews).toEqual([]);
    await review.locator('summary').click();
    await pane.getByLabel('Reason', { exact: true }).fill('Verified the retained source evidence');
    await pane.getByRole('button', { name: 'Save review', exact: true }).click();
    await claimCards.first().waitFor();
    expect(reviews).toEqual([{ id: 'claim-13', status: 'accepted', reason: 'Verified the retained source evidence', actor: 'user' }]);

    await map.press("ArrowRight");
    await pane.getByRole("heading", { name: "polar-coordinates", exact: true }).waitFor();
    expect(await pane.getByText(longExcerpt).count()).toBe(0);
    expect(new Set(memoryRequests)).toEqual(new Set(["source-polar"]));

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await pane.isVisible()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.SHALE_NODE_SCREENSHOT) await page.screenshot({ path: process.env.SHALE_NODE_SCREENSHOT, fullPage: true });
    expect(errors).toEqual([]);
  } finally { await browser.close(); host.close(); }
}, 30_000);
