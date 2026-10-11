import { test, expect } from "bun:test";
import {
  chromium,
  type BrowserContext,
  type Worker,
  type Page,
} from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserFixture } from "./fixtures/browser-connector";
import { handleIngestRequest } from "../main/ingest-http";
import { accept, inspect, capabilities } from "../extensions/browser/subscribe";
import { runWorker } from "../extensions/browser/worker";
import { browserStatus } from "../extensions/browser/status";
const integration = process.env.SHALE_BROWSER_E2E === "1" ? test : test.skip;
async function eventually(
  check: () => Promise<boolean> | boolean,
  timeout = 15000,
) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error("Integration condition timed out");
}
integration(
  "unpacked Chrome retains offline captures across restart and resumes popup imports",
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "shale-chrome-")),
      fixture = browserFixture();
    fixture.policy.enableLlmAnalysis = false;
    const extension = join(
      import.meta.dir,
      "../scripts/browser-chrome-extension",
    );
    let context: BrowserContext | undefined;
    let control!: Page;
    const pageServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new Response(
          `<html><head><title>SQLite fixture</title><style>.private{display:none}</style></head><body><nav>Menu login boilerplate</nav><main><h1>SQLite ${new URL(request.url).pathname}</h1><h2>Indexes</h2><p>${"SQLite indexes improve database lookups. ".repeat(8)}</p><pre>SELECT *\n  FROM records;\nSELECT *\n  FROM records;</pre><table><tr><th>Name</th><th>Cost</th></tr><tr><td>Index</td><td>2</td></tr></table><p class="private">CSS secret</p><script>setTimeout(()=>{const p=document.createElement('p');p.textContent='Hydrated SQLite evidence';document.querySelector('main').append(p)},100)</script></main></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
    });
    const targets = [
      {
        reciever_name: "browser",
        accept: (item: any) => accept(item, fixture.sdk),
      },
    ];
    const serve = (port = 0) =>
      Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: (request) => {
          const path = new URL(request.url).pathname;
          if (path === "/health")
            return Response.json({
              service: "shale",
              processors: [
                { name: "browser", durable: true, ...capabilities() },
              ],
            });
          if (path === "/ingest")
            return handleIngestRequest(request, targets, () => {
              throw new Error("Durable admission must bypass queue");
            });
          return inspect(request, fixture.sdk);
        },
      });
    let host = serve();
    const port = host.port!,
      endpoint = `http://127.0.0.1:${port}/ingest`;
    async function launch() {
      context = await chromium.launchPersistentContext(profile, {
        executablePath: process.env.SHALE_CHROMIUM_PATH || "/usr/bin/chromium",
        channel: "chromium",
        headless: true,
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
          "--no-sandbox",
        ],
      });
      const worker =
        context.serviceWorkers()[0] ||
        (await context.waitForEvent("serviceworker"));
      control = await context.newPage();
      await control.goto(worker.url().replace("background.js", "popup.html"));
      return worker;
    }
    const rows = (worker: Worker): Promise<any[]> =>
      control.evaluate<any[]>(
        `import(chrome.runtime.getURL('outbox.js')).then(m=>m.outboxItems())`,
      );
    const deliver = (worker: Worker) =>
      control.evaluate(
        `import(chrome.runtime.getURL('delivery.js')).then(m=>m.deliverOutbox())`,
      );
    try {
      let worker = await launch();
      await worker.evaluate(
        `chrome.storage.local.set({serverUrl:${JSON.stringify(endpoint)},excludeDomains:[],autoSyncActive:true,currentGoal:'Learn SQLite',totalIngestedCount:500,initialSyncCompleted:true})`,
      );
      await control.evaluate(
        `import(chrome.runtime.getURL('delivery.js')).then(m=>m.checkConnection())`,
      );
      host.stop(true);
      let stopped = false;
      const page = await context!.newPage();
      for (const path of ["/A", "/B", "/A"]) {
        await page.goto(`${pageServer.url.origin}${path}`);
        const expected =
          path === "/B"
            ? 2
            : page.url().endsWith("/A") &&
                (await rows(worker)).filter(
                  (x: any) => x.record?.type === "page_visit",
                ).length >= 2
              ? 3
              : 1;
        await eventually(async () => {
          const items = await rows(worker);
          return (
            items.filter((x: any) => x.record?.type === "page_visit").length >=
            expected
          );
        });
        if (!stopped) {
          const cdp = await context!.browser()!.newBrowserCDPSession();
          const targets = await cdp.send("Target.getTargets");
          const target = targets.targetInfos.find(
            (target: any) =>
              target.type === "service_worker" && target.url === worker.url(),
          );
          expect(target).toBeTruthy();
          const closed = await cdp.send("Target.closeTarget", {
            targetId: target!.targetId,
          });
          expect(closed.success).toBe(true);
          await cdp.detach();
          stopped = true;
        }
      }
      await eventually(
        async () =>
          (await rows(worker)).filter(
            (x: any) => x.record?.type === "page_visit",
          ).length === 3,
      );
      const offline = await rows(worker),
        captures = offline.filter((x: any) => x.record?.type === "page_visit");
      expect(captures).toHaveLength(3);
      const text = captures[0].record.textContent;
      expect(text).toContain("Hydrated SQLite evidence");
      expect(text).toContain("SELECT *\n  FROM records");
      expect(text).not.toContain("CSS secret");
      expect(text).not.toContain("boilerplate");
      expect(
        captures[0].record.blocks.some((b: any) => b.kind === "table"),
      ).toBe(true);
      // Close the popup immediately after job admission: the worker owns the import.
      const popup = await context!.newPage();
      await popup.goto(worker.url().replace("background.js", "popup.html"));
      const result = await popup.evaluate<any>(
        `chrome.runtime.sendMessage({action:'run_full_import',options:{importTabs:true,importBookmarks:false,importHistory:false}})`,
      );
      expect(result.success).toBe(true);
      await popup.close();
      await context!.close();
      context = undefined;
      host = serve(port);
      worker = await launch();
      const retained = await rows(worker);
      expect(
        captures.every((old: any) =>
          retained.some((row: any) => row.id === old.id),
        ),
      ).toBe(true);
      const saved = await worker.evaluate<any>(
        `chrome.storage.local.get(['totalIngestedCount','initialSyncCompleted'])`,
      );
      expect(saved.totalIngestedCount).toBe(500);
      expect(saved.initialSyncCompleted).toBe(true);
      await control.evaluate(
        `import(chrome.runtime.getURL('outbox.js')).then(async m=>m.updateItems((await m.outboxItems()).filter(x=>x.state==='pending').map(x=>x.id),x=>({...x,nextAttemptAt:0})))`,
      );
      await deliver(worker);
      await runWorker(fixture.sdk);
      await deliver(worker);
      expect(browserStatus(fixture.sdk).counts.indexed).toBeGreaterThanOrEqual(
        6,
      );
      const visits = fixture.database
        .query<any, []>(
          "SELECT payload FROM browser_activity WHERE json_extract(payload,'$.kind')='navigation' ORDER BY occurred_at,sequence",
        )
        .all()
        .map((row) => JSON.parse(row.payload));
      expect(
        visits
          .filter((x) => x.url.startsWith(pageServer.url.origin))
          .slice(0, 3)
          .map((x) => new URL(x.url).pathname),
      ).toEqual(["/A", "/B", "/A"]);
      expect(new Set(visits.map((x) => x.eventId)).size).toBe(visits.length);
      // This E2E disables page analysis and the visits have not idled into a
      // session yet, so ingestion should not call the model at all.
      expect(fixture.trace).toEqual([]);
      expect(
        (await rows(worker))
          .filter((row: any) => captures.some((x: any) => x.id === row.id))
          .every((row: any) => row.state === "indexed"),
      ).toBe(true);
    } finally {
      await context?.close();
      host.stop(true);
      pageServer.stop(true);
      fixture.database.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
  60000,
);
