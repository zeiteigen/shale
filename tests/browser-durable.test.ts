import { describe, it, expect } from "bun:test";
import {
  browserFixture,
  batch,
  capture,
  navigation,
} from "./fixtures/browser-connector";
import { admitBrowserPayload } from "../extensions/browser/admission";
import { runWorker } from "../extensions/browser/worker";
import { run as recover } from "../extensions/browser/recover";
import { browserStatus, retryBrowserJobs } from "../extensions/browser/status";
import { pendingJobs } from "../extensions/browser/inbox-store";
import { queryBrowser, correctContext } from "../extensions/browser/retrieval";
import { buildSequentialEdges } from "../extensions/browser/navigation";
import { pendingSessions } from "../extensions/browser/session-reducer";
import { handleIngestRequest } from "../main/ingest-http";
import { accept } from "../extensions/browser/subscribe";
import { acquireTaskLease } from "../lib/task-lease";
function count(db: any, table: string) {
  return db.query(`SELECT count(*) AS n FROM ${table}`).get().n;
}
describe("Browser durable processing", () => {
  it("acknowledges committed jobs through the host without the volatile queue; rejects malformed input", async () => {
    const f = browserFixture();
    try {
      let queued = 0;
      const targets = [
        {
          reciever_name: "browser",
          accept: (item: any) => accept(item, f.sdk),
        },
      ];
      const request = (payload: any) =>
        new Request("http://local/ingest", {
          method: "POST",
          body: JSON.stringify({
            target_processor: "browser",
            content: JSON.stringify(payload),
            metadata: { connector: "chrome", data_origin: "chrome" },
          }),
        });
      const response = await handleIngestRequest(
        request(batch([capture("a")])),
        targets,
        () => queued++,
      );
      expect(response.status).toBe(202);
      expect(count(f.database, "browser_jobs")).toBe(1);
      expect(queued).toBe(0);
      const replay = await handleIngestRequest(
        request(batch([capture("a")], "replay")),
        targets,
        () => queued++,
      );
      expect((await replay.json()).records[0].status).toBe("duplicate");
      expect(count(f.database, "browser_jobs")).toBe(1);
      expect(
        (
          await handleIngestRequest(
            request(batch([{ ...capture("bad"), textContent: undefined }])),
            targets,
            () => queued++,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await handleIngestRequest(
            request(batch([{ ...capture("a"), textContent: "Changed" }])),
            targets,
            () => queued++,
          )
        ).status,
      ).toBe(409);
    } finally {
      f.database.close();
    }
  });
  it("rolls back entire overload batches and stores no private content", () => {
    const f = browserFixture();
    try {
      f.policy.maxPendingJobs = 1;
      expect(() =>
        admitBrowserPayload(f.sdk, batch([capture("a"), capture("b")])),
      ).toThrow("full");
      expect(count(f.database, "browser_jobs")).toBe(0);
      const receipt = admitBrowserPayload(
        f.sdk,
        batch([{ ...capture("private"), incognito: true }]),
      );
      expect(receipt.records[0].status).toBe("skipped");
      const row = f.database
        .query<any, []>("SELECT payload FROM browser_jobs")
        .get();
      expect(row.payload).toBe('{"type":"ping"}');
      expect(count(f.database, "browser_activity")).toBe(0);
    } finally {
      f.database.close();
    }
  });
  it("migrates the old inbox transactionally and preserves both captures", () => {
    const f = browserFixture();
    try {
      f.sdk.state.setJson("pending-ingest", [
        { id: "old-a", receivedAt: 1, payload: capture("a") },
        { id: "old-b", receivedAt: 2, payload: capture("b") },
      ]);
      expect(pendingJobs(f.sdk)).toHaveLength(2);
      expect(f.sdk.state.get("pending-ingest")).toBeNull();
      expect(pendingJobs(f.sdk)).toHaveLength(2);
    } finally {
      f.database.close();
    }
  });
  it("prepares chats and reuses unchanged content", async () => {
    const f = browserFixture();
    try {
      admitBrowserPayload(
        f.sdk,
        batch([capture("a"), capture("b", "https://example.com/other")]),
      );
      await runWorker(f.sdk);
      expect(f.trace.filter((x) => x === "chat")).toHaveLength(2);
      expect(browserStatus(f.sdk).counts.indexed).toBe(2);
      f.trace.length = 0;
      admitBrowserPayload(f.sdk, batch([capture("new-capture")], "new"));
      await runWorker(f.sdk);
      expect(f.trace).toEqual([]);
      const status = browserStatus(f.sdk);
      expect(status.counts.indexed).toBe(3);
      expect(
        status.records.find((x) => x.recordId === "new-capture")?.outcome
          .reused,
      ).toBe(true);
    } finally {
      f.database.close();
    }
  });
  it("recovers prepared jobs after commit failure without repeating chat", async () => {
    const f = browserFixture();
    try {
      const receipt = admitBrowserPayload(f.sdk, batch([capture("a")]));
      f.database.run(`CREATE TEMP TRIGGER fail_source_commit BEFORE INSERT ON sources
        BEGIN SELECT RAISE(ABORT, 'Injected commit failure'); END`);
      await runWorker(f.sdk);
      expect(browserStatus(f.sdk).counts.prepared).toBe(1);
      expect(f.sdk.checkpoint.hasQueued()).toBe(true);
      f.trace.length = 0;
      f.database.run("DROP TRIGGER fail_source_commit");
      await recover(f.sdk);
      expect(f.trace.some((x) => x === "chat")).toBe(false);
      expect(
        browserStatus(f.sdk, [receipt.records[0].jobId]).records[0].status,
      ).toBe("indexed");
      expect(f.sdk.checkpoint.hasQueued()).toBe(false);
    } finally {
      f.database.close();
    }
  });
  it("isolates exhausted jobs and permits explicit retry", async () => {
    const f = browserFixture();
    try {
      admitBrowserPayload(f.sdk, batch([capture("a")]));
      f.database.run(`CREATE TEMP TRIGGER fail_source_commit BEFORE INSERT ON sources
        BEGIN SELECT RAISE(ABORT, 'Injected commit failure'); END`);
      await runWorker(f.sdk);
      f.database.run("UPDATE browser_jobs SET next_attempt_at=0");
      await runWorker(f.sdk);
      expect(browserStatus(f.sdk).counts.failed).toBe(1);
      expect(f.sdk.checkpoint.hasQueued()).toBe(false);
      const id = browserStatus(f.sdk).records[0].jobId;
      retryBrowserJobs(f.sdk, [id]);
      f.database.run("DROP TRIGGER fail_source_commit");
      f.trace.length = 0;
      await runWorker(f.sdk);
      expect(browserStatus(f.sdk).counts.indexed).toBe(1);
      expect(f.trace.includes("chat")).toBe(false);
    } finally {
      f.database.close();
    }
  });
  it("does not run when another worker owns the lease", async () => {
    const f = browserFixture();
    try {
      admitBrowserPayload(f.sdk, batch([capture("a")]));
      const lease = acquireTaskLease(
        f.database,
        "browser",
        "browser-worker-lease",
      );
      expect(await runWorker(f.sdk)).toMatchObject({ busy: true });
      f.sdk.saveCheckpoint({ type: "browser_page_analysis" }, { id: "owned-checkpoint" });
      expect(await recover(f.sdk)).toMatchObject({ busy: true });
      expect(f.sdk.checkpoint.get("owned-checkpoint")).not.toBeNull();
      f.sdk.deleteCheckpoint("owned-checkpoint");
      expect(f.trace).toEqual([]);
      lease!.release();
      await runWorker(f.sdk);
      expect(browserStatus(f.sdk).counts.indexed).toBe(1);
    } finally {
      f.database.close();
    }
  });
  it("retains A B A in observed order with interleaved tabs and per-document attention", () => {
    const f = browserFixture();
    try {
      const t = Date.now() - 180000;
      const events = [
        navigation("a", t, 1, "https://example.com/A"),
        navigation("x", t + 1, 2, "https://other.com/X"),
        navigation("b", t + 2, 1, "https://example.com/B"),
        navigation("a2", t + 4, 1, "https://example.com/A"),
      ];
      admitBrowserPayload(f.sdk, batch([...events].reverse()));
      admitBrowserPayload(
        f.sdk,
        batch(
          [
            {
              ...navigation("attention", t + 3),
              kind: "attention",
              documentId: "b",
              durationMs: 30,
              attended: true,
            },
          ],
          "attention",
        ),
      );
      const session = pendingSessions(f.sdk, f.policy)[0]!;
      expect(session.visits.map((v) => v.eventId)).toEqual([
        "a",
        "x",
        "b",
        "a2",
      ]);
      const edges = buildSequentialEdges(session.visits);
      expect(edges.map((x) => [x.source, x.target])).toEqual([
        ["https://example.com/A", "https://example.com/B"],
        ["https://example.com/B", "https://example.com/A"],
      ]);
      expect(session.visits.map((v) => v.durationMs)).toEqual([0, 0, 30, 0]);
    } finally {
      f.database.close();
    }
  });
  it("keeps interleaved goals distinct, returns evidence, and preserves user corrections", async () => {
    const f = browserFixture();
    try {
      const t = Date.now() - 180000;
      admitBrowserPayload(
        f.sdk,
        batch([
          { ...capture("page"), eventId: "db" },
          navigation("db", t, 1, "https://example.com/sqlite", "Learn SQLite"),
          navigation(
            "garden",
            t + 1,
            2,
            "https://garden.com/plants",
            "Grow tomatoes",
          ),
        ]),
      );
      await runWorker(f.sdk);
      expect(
        queryBrowser(f.sdk, { goal: "Learn SQLite" }).pages.some((x) =>
          x.passage.includes("SQLite"),
        ),
      ).toBe(true);
      expect(queryBrowser(f.sdk).threads).toHaveLength(2);
      const before = f.database
        .query<any, []>(
          "SELECT payload FROM browser_activity ORDER BY event_id",
        )
        .all();
      correctContext(f.sdk, {
        collectorId: "collector",
        eventIds: ["db"],
        label: "Database project",
        goal: "Optimize queries",
      });
      await runWorker(f.sdk);
      expect(
        queryBrowser(f.sdk, { goal: "Optimize queries" }).threads[0]?.label,
      ).toBe("Database project");
      expect(
        f.database
          .query<any, []>(
            "SELECT payload FROM browser_activity ORDER BY event_id",
          )
          .all(),
      ).toEqual(before);
      const observed = f.database
        .query<any, []>(
          "SELECT text_content FROM chunks c JOIN sources s ON s.id=c.source_id WHERE s.type='web_session' AND c.chunk_type='verbatim'",
        )
        .get();
      expect(observed.text_content).not.toContain(
        "Evidence about SQLite indexes",
      );
    } finally {
      f.database.close();
    }
  });
});
it("bookmark moves, returns, deletions and late revisions preserve current state and rich pages", async () => {
  const f = browserFixture();
  try {
    admitBrowserPayload(f.sdk, batch([capture("page")]));
    await runWorker(f.sdk);
    const bookmark = (id: string, sequence: number, parentId: string) => ({
      type: "bookmark_item",
      recordId: id,
      id: "bookmark-1",
      url: "https://example.com/sqlite",
      title: "SQLite",
      parentId,
      folderPath: parentId,
      dateAdded: 10,
      sequence,
      folders: [{ id: parentId, title: "Name / containing slash" }],
    });
    for (const record of [
      bookmark("first", 1, "folder-A"),
      bookmark("move", 2, "folder-B"),
      bookmark("return", 3, "folder-A"),
    ]) {
      admitBrowserPayload(f.sdk, batch([record], record.recordId));
      await runWorker(f.sdk);
    }
    const catalog = () =>
      f.database
        .query<any, []>("SELECT * FROM browser_catalog WHERE kind='bookmark'")
        .get();
    expect(JSON.parse(catalog().payload).parentId).toBe("folder-A");
    admitBrowserPayload(
      f.sdk,
      batch([bookmark("late", 2, "folder-C")], "late"),
    );
    await runWorker(f.sdk);
    expect(JSON.parse(catalog().payload).parentId).toBe("folder-A");
    admitBrowserPayload(
      f.sdk,
      batch(
        [
          {
            type: "catalog_delete",
            catalog: "bookmark",
            recordId: "delete",
            ids: ["bookmark-1"],
            sequence: 4,
          },
        ],
        "delete",
      ),
    );
    await runWorker(f.sdk);
    expect(catalog().active).toBe(0);
    expect(
      f.database
        .query("SELECT 1 FROM sources WHERE id=?")
        .get(catalog().source_id),
    ).toBeTruthy();
    expect(
      f.database
        .query<any, []>(
          "SELECT count(*) AS n FROM graph_claims WHERE predicate='IN_FOLDER' AND status='accepted'",
        )
        .get().n,
    ).toBe(0);
    expect(
      queryBrowser(f.sdk, { query: "SQLite" }).pages.some((x) =>
        x.passage.includes("SQLite"),
      ),
    ).toBe(true);
  } finally {
    f.database.close();
  }
});
it("collector and domain filters select exact hosts and apply context filtering before limits", async () => {
  const f = browserFixture();
  try {
    const t = Date.now() - 180000;
    admitBrowserPayload(
      f.sdk,
      batch([
        capture("good", "http://docs.example.com/sqlite"),
        capture("bad", "https://evil-example.com/sqlite"),
        navigation(
          "visit",
          t,
          1,
          "http://docs.example.com/sqlite",
          "Database goal",
        ),
      ]),
    );
    await runWorker(f.sdk);
    const result = queryBrowser(f.sdk, { domain: "example.com" });
    expect(result.pages.length).toBeGreaterThan(0);
    expect(
      result.pages.every((x) =>
        new URL(x.url).hostname.endsWith(".example.com"),
      ),
    ).toBe(true);
    expect(queryBrowser(f.sdk, { collectorId: "different" }).threads).toEqual(
      [],
    );
    expect(queryBrowser(f.sdk, { goal: "missing", limit: 1 }).sessions).toEqual(
      [],
    );
  } finally {
    f.database.close();
  }
});
it("rejects conflicting immutable events even if delivered under a different record ID", () => {
  const f = browserFixture();
  try {
    const event = navigation("event", 10);
    admitBrowserPayload(f.sdk, batch([event]));
    expect(() =>
      admitBrowserPayload(
        f.sdk,
        batch(
          [{ ...event, recordId: "another", url: "https://different.com" }],
          "conflict",
        ),
      ),
    ).toThrow("observations");
    expect(
      f.database.query<any, []>("SELECT count(*) AS n FROM browser_jobs").get()
        .n,
    ).toBe(1);
  } finally {
    f.database.close();
  }
});
it("indexes observed activity immediately, then replaces sessions after late event arrival", async () => {
  const f = browserFixture();
  try {
    const t = Date.now() - 180000;
    admitBrowserPayload(f.sdk, batch([navigation("later", t + 10)], "later"));
    await runWorker(f.sdk);
    expect(
      f.database
        .query<any, []>(
          "SELECT count(*) AS n FROM sources WHERE type='browser_activity'",
        )
        .get().n,
    ).toBe(1);
    expect(
      f.database
        .query<any, []>(
          "SELECT count(*) AS n FROM sources WHERE type='web_session'",
        )
        .get().n,
    ).toBe(1);
    admitBrowserPayload(f.sdk, batch([navigation("earlier", t)], "earlier"));
    await runWorker(f.sdk);
    expect(
      f.database
        .query<any, []>(
          "SELECT count(*) AS n FROM sources WHERE type='web_session'",
        )
        .get().n,
    ).toBe(1);
    expect(queryBrowser(f.sdk).sessions).toHaveLength(1);
    expect(
      f.database
        .query<any, []>("SELECT count(*) AS n FROM browser_activity")
        .get().n,
    ).toBe(2);
    expect(
      f.database
        .query<any, []>(
          "SELECT count(*) AS n FROM sources WHERE type='browser_activity'",
        )
        .get().n,
    ).toBe(2);
  } finally {
    f.database.close();
  }
});
it("rolls back a graph failure while successful siblings commit, then retries frozen output", async () => {
  const f = browserFixture();
  try {
    f.database.run(
      `CREATE TRIGGER injected_failure BEFORE INSERT ON graph_claims WHEN NEW.context='https://example.com/sqlite' AND NEW.predicate='SUMMARY' BEGIN SELECT RAISE(ABORT,'Injected graph failure'); END;`,
    );
    admitBrowserPayload(
      f.sdk,
      batch([
        capture("fails"),
        capture("succeeds", "https://example.com/other"),
      ]),
    );
    await runWorker(f.sdk);
    expect(browserStatus(f.sdk).counts.indexed).toBe(1);
    expect(browserStatus(f.sdk).counts.prepared).toBe(1);
    expect(
      f.database
        .query("SELECT 1 FROM sources WHERE uri='https://example.com/sqlite'")
        .get(),
    ).toBeNull();
    f.database.run("DROP TRIGGER injected_failure");
    f.database.run("UPDATE browser_jobs SET next_attempt_at=0");
    f.trace.length = 0;
    f.policy.enableLlmAnalysis = false;
    f.policy.chunkSize = 800;
    await runWorker(f.sdk);
    expect(browserStatus(f.sdk).counts.indexed).toBe(2);
    expect(f.trace.includes("chat")).toBe(false);
    const chunks = f.database
      .query<any, []>(
        "SELECT text_content FROM chunks c JOIN sources s ON s.id=c.source_id WHERE s.uri='https://example.com/sqlite' AND c.chunk_type='verbatim'",
      )
      .all();
    expect(
      chunks.some(
        (row) =>
          row.text_content.length <= 200 && row.text_content.includes("SQLite"),
      ),
    ).toBe(true);
  } finally {
    f.database.close();
  }
});
it("retains and exhausts failed session commits independently of indexed activity", async () => {
  const f = browserFixture();
  try {
    const t = Date.now() - 180000;
    f.database.run(
      `CREATE TRIGGER injected_session_failure BEFORE INSERT ON sources WHEN NEW.type='web_session' BEGIN SELECT RAISE(ABORT,'Injected session failure'); END;`,
    );
    admitBrowserPayload(
      f.sdk,
      batch([
        navigation("first", t),
        navigation("second", t + 1, 1, "https://example.com/other"),
      ]),
    );
    await runWorker(f.sdk);
    expect(browserStatus(f.sdk).counts.indexed).toBe(2);
    expect(browserStatus(f.sdk).sessions[0].attempts).toBe(1);
    f.trace.length = 0;
    f.database.run("UPDATE browser_sessions SET next_attempt_at=0");
    await runWorker(f.sdk);
    expect(f.trace.includes("chat")).toBe(false);
    expect(browserStatus(f.sdk).sessions[0].attempts).toBe(2);
    expect(f.sdk.checkpoint.hasQueued()).toBe(false);
    const checkpoint = f.sdk.checkpoint.getAll()[0]!;
    retryBrowserJobs(f.sdk, [checkpoint.id]);
    f.database.run("DROP TRIGGER injected_session_failure");
    await runWorker(f.sdk);
    expect(browserStatus(f.sdk).sessions[0].indexed).toBe(1);
    expect(f.sdk.checkpoint.hasQueued()).toBe(false);
  } finally {
    f.database.close();
  }
});
it("recovers a managed session checkpoint with frozen settings and no repeated chat", async () => {
  const f = browserFixture();
  try {
    const t = Date.now() - 180000;
    f.database.run(
      `CREATE TRIGGER injected_session_recovery BEFORE INSERT ON sources WHEN NEW.type='web_session' BEGIN SELECT RAISE(ABORT,'Injected session failure'); END;`,
    );
    admitBrowserPayload(
      f.sdk,
      batch([
        navigation("one", t),
        navigation("two", t + 1, 1, "https://example.com/other"),
      ]),
    );
    await runWorker(f.sdk);
    expect(f.sdk.checkpoint.hasQueued()).toBe(true);
    f.trace.length = 0;
    f.policy.enableLlmAnalysis = false;
    f.database.run("DROP TRIGGER injected_session_recovery");
    const result = await recover(f.sdk);
    expect(result.recoveredSessions).toBe(1);
    expect(f.trace.includes("chat")).toBe(false);
    expect(browserStatus(f.sdk).sessions[0].indexed).toBe(1);
  } finally {
    f.database.close();
  }
});
it("attributes delayed SPA attention to the navigation that started its interval", () => {
  const f = browserFixture();
  try {
    const t = Date.now() - 180000;
    admitBrowserPayload(
      f.sdk,
      batch([
        {
          ...navigation("route-a", t, 1, "https://example.com/#/A"),
          documentId: "document",
        },
        {
          ...navigation("route-b", t + 1, 1, "https://example.com/#/B"),
          documentId: "document",
        },
        {
          ...navigation("attention", t + 2, 1, "https://example.com/#/A"),
          kind: "attention",
          documentId: "document",
          navigationEventId: "route-a",
          durationMs: 40,
          attended: true,
        },
      ]),
    );
    const session = pendingSessions(f.sdk, f.policy)[0]!;
    expect(session.visits.map((v) => v.durationMs)).toEqual([40, 0]);
  } finally {
    f.database.close();
  }
});
it("keeps opt-in public enrichment separate from captured DOM and observed visits", async () => {
  const f = browserFixture();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests++;
      return new Response(
        `<main><h1>Public reference</h1><p>${"Public SQLite reference evidence. ".repeat(10)}</p></main>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  try {
    const url = server.url.href;
    const record = { type: "public_page_capture", recordId: "disabled", url };
    expect(admitBrowserPayload(f.sdk, batch([record])).records[0].status).toBe(
      "skipped",
    );
    expect(requests).toBe(0);
    const parserSDK = (await import("../sdk")).createExtensionSDK(
      "web-page-parser",
      { database: f.database },
    );
    parserSDK.settings.getAll = () =>
      ({ allowFetch: true, enableLlmContext: false }) as any;
    const { parseWebPage } =
      await import("../extensions/web-page-parser/parser");
    f.sdk.messages.handle(
      "web:parse",
      (input) => parseWebPage(parserSDK, input),
      { name: "web-page-parser", priority: 100 },
    );
    f.policy.allowPublicPageEnrichment = true;
    f.policy.enableLlmAnalysis = false;
    admitBrowserPayload(f.sdk, batch([capture("live", url)], "live"));
    await runWorker(f.sdk);
    admitBrowserPayload(
      f.sdk,
      batch([{ ...record, recordId: "public" }], "public"),
    );
    await runWorker(f.sdk);
    expect(requests).toBe(1);
    expect(
      f.database
        .query<any, []>(
          "SELECT count(*) AS n FROM sources WHERE type IN ('web_page','public_web_page')",
        )
        .get().n,
    ).toBe(2);
    const results = queryBrowser(f.sdk, {
      query: "Public SQLite",
      domain: "127.0.0.1",
    }).pages;
    expect(
      results.some(
        (page) =>
          page.captureOrigin === "public-fetch" &&
          page.passage.includes("Public SQLite"),
      ),
    ).toBe(true);
    expect(
      f.database
        .query<any, []>("SELECT count(*) AS n FROM browser_activity")
        .get().n,
    ).toBe(0);
    expect(
      f.database
        .query<any, []>(
          "SELECT text_content FROM chunks c JOIN sources s ON s.id=c.source_id WHERE s.type='web_page' AND c.chunk_index=1",
        )
        .get().text_content,
    ).toContain("SQLite supports useful");
  } finally {
    server.stop(true);
    f.database.close();
  }
});
it("labels backfilled observations and does not infer tab navigation without tab evidence", async () => {
  const f = browserFixture();
  try {
    const t = Date.now() - 180000;
    admitBrowserPayload(
      f.sdk,
      batch([
        {
          ...navigation("history-1", t),
          kind: "history_backfill",
          tabId: undefined,
          windowId: undefined,
          attended: false,
        },
        {
          ...navigation("history-2", t + 1, 1, "https://other.com"),
          kind: "history_backfill",
          tabId: undefined,
          windowId: undefined,
          attended: false,
        },
      ]),
    );
    const session = pendingSessions(f.sdk, f.policy)[0]!;
    expect(session.visits).toHaveLength(2);
    expect(buildSequentialEdges(session.visits)).toEqual([]);
    await runWorker(f.sdk);
    expect(
      f.database
        .query<any, []>(
          "SELECT count(*) AS n FROM sources WHERE type='browser_activity'",
        )
        .get().n,
    ).toBe(2);
  } finally {
    f.database.close();
  }
});
it("retrieves the version captured for an old session and reuses returning content without model calls", async () => {
  const f = browserFixture();
  try {
    f.policy.enableLlmAnalysis = false;
    const t = Date.now() - 86400000,
      url = "https://example.com/changing";
    const old = {
      ...capture("old", url, t),
      eventId: "old-visit",
      captureOrigin: "live-dom",
      capturedAt: t,
      textContent: "Historical SQLite indexing evidence. ".repeat(5),
    };
    admitBrowserPayload(
      f.sdk,
      batch([old, navigation("old-visit", t, 1, url, "Learn SQLite")], "old"),
    );
    await runWorker(f.sdk);
    const fresh = {
      ...capture("fresh", url, t + 3600000),
      eventId: "fresh-visit",
      captureOrigin: "live-dom",
      capturedAt: t + 3600000,
      textContent: "Fresh gardening tomato evidence. ".repeat(5),
    };
    admitBrowserPayload(
      f.sdk,
      batch(
        [
          fresh,
          navigation("fresh-visit", t + 3600000, 1, url, "Grow tomatoes"),
        ],
        "fresh",
      ),
    );
    await runWorker(f.sdk);
    const historical = queryBrowser(f.sdk, {
      goal: "Learn SQLite",
      from: t - 1,
      to: t + 1000,
    });
    expect(historical.pages.length).toBeGreaterThan(0);
    expect(
      historical.pages.some((page) =>
        page.passage.includes("Historical SQLite"),
      ),
    ).toBe(true);
    expect(
      historical.pages.every(
        (page) => !page.passage.includes("Fresh gardening"),
      ),
    ).toBe(true);
    expect(
      queryBrowser(f.sdk, { query: "gardening" }).pages.some((page) =>
        page.passage.includes("Fresh gardening"),
      ),
    ).toBe(true);
    f.trace.length = 0;
    admitBrowserPayload(
      f.sdk,
      batch(
        [
          {
            ...old,
            recordId: "returning",
            eventId: undefined,
            visitedAt: t + 7200000,
            capturedAt: t + 7200000,
          },
        ],
        "returning",
      ),
    );
    await runWorker(f.sdk);
    expect(f.trace).toEqual([]);
    expect(
      queryBrowser(f.sdk, { query: "Historical" }).pages.some((page) =>
        page.passage.includes("Historical SQLite"),
      ),
    ).toBe(true);
    expect(
      f.database
        .query<any, []>(
          "SELECT count(*) AS n FROM sources WHERE type='web_page_version'",
        )
        .get().n,
    ).toBe(2);
    const row = f.database
      .query<any, []>(
        "SELECT payload,payload_hash FROM browser_jobs WHERE record_id='old'",
      )
      .get();
    expect(row.payload).not.toContain("Historical SQLite");
    expect(row.payload_hash).toHaveLength(64);
    expect(
      admitBrowserPayload(f.sdk, batch([old], "replay")).records[0].status,
    ).toBe("duplicate");
  } finally {
    f.database.close();
  }
});
it("exhausts a managed job during startup recovery so it cannot block later cron work forever", async () => {
  const f = browserFixture();
  try {
    admitBrowserPayload(f.sdk, batch([capture("startup-failure")]));
    f.database.run(`CREATE TEMP TRIGGER fail_source_commit BEFORE INSERT ON sources
      BEGIN SELECT RAISE(ABORT, 'Injected commit failure'); END`);
    await runWorker(f.sdk);
    expect(browserStatus(f.sdk).counts.prepared).toBe(1);
    await expect(recover(f.sdk)).rejects.toThrow("recovery failed");
    expect(browserStatus(f.sdk).counts.failed).toBe(1);
    expect(f.sdk.checkpoint.hasQueued()).toBe(false);
    f.database.run("DROP TRIGGER fail_source_commit");
    admitBrowserPayload(
      f.sdk,
      batch([capture("healthy", "https://example.com/healthy")], "healthy"),
    );
    await runWorker(f.sdk);
    expect(browserStatus(f.sdk).counts.indexed).toBe(1);
    expect(browserStatus(f.sdk).counts.failed).toBe(1);
  } finally {
    f.database.close();
  }
});
it("migrates a stored legacy active session without dropping repeated visits", () => {
  const f = browserFixture();
  try {
    f.sdk.state.setJson("active_session_state", {
      sessionId: "old-session",
      startTime: 1,
      lastActivityTime: 3,
      visits: [
        {
          url: "https://example.com/A",
          title: "A",
          domain: "example.com",
          visitedAt: 1,
          tabId: 1,
        },
        {
          url: "https://example.com/B",
          title: "B",
          domain: "example.com",
          visitedAt: 2,
          tabId: 1,
        },
        {
          url: "https://example.com/A",
          title: "A again",
          domain: "example.com",
          visitedAt: 3,
          tabId: 1,
        },
      ],
    });
    expect(pendingJobs(f.sdk)).toHaveLength(3);
    expect(f.sdk.state.get("active_session_state")).toBeNull();
    expect(pendingJobs(f.sdk)).toHaveLength(3);
    expect(
      pendingSessions(f.sdk, f.policy)[0]?.visits.map((visit) => visit.title),
    ).toEqual(["A", "B", "A again"]);
  } finally {
    f.database.close();
  }
});
