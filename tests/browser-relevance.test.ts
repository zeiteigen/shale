import { it, expect } from "bun:test";
import {
  browserFixture,
  batch,
  capture,
  navigation,
} from "./fixtures/browser-connector";
import { admitBrowserPayload } from "../extensions/browser/admission";
import { runWorker } from "../extensions/browser/worker";
import { queryBrowser } from "../extensions/browser/retrieval";
// Small relevance baseline: two interleaved goals, with one resumed in another session.
it("returns substantive passages for the requested goal, date window and topic trail", async () => {
  const f = browserFixture();
  f.policy.enableLlmAnalysis = false;
  const yesterday = Date.now() - 86400000;
  try {
    admitBrowserPayload(
      f.sdk,
      batch([
        {
          ...capture("sqlite"),
          eventId: "db-start",
          visitedAt: yesterday,
          title: "SQLite query planning",
          textContent:
            "SQLite composite indexes improve database query performance. ".repeat(
              5,
            ),
        },
        {
          ...capture("tomato", "https://garden.com/tomatoes"),
          eventId: "garden",
          visitedAt: yesterday + 1,
          title: "Tomato growing",
          textContent:
            "Tomato seedlings need sunlight, water and good soil drainage. ".repeat(
              5,
            ),
        },
        navigation(
          "db-start",
          yesterday,
          1,
          "https://example.com/sqlite",
          "Learn SQLite",
        ),
        navigation(
          "garden",
          yesterday + 1,
          2,
          "https://garden.com/tomatoes",
          "Grow tomatoes",
        ),
        {
          ...capture("sqlite-resume"),
          eventId: "db-resume",
          visitedAt: yesterday + 3600000,
          title: "SQLite query planning",
          textContent:
            "SQLite composite indexes improve database query performance. ".repeat(
              5,
            ),
        },
        navigation(
          "db-resume",
          yesterday + 3600000,
          1,
          "https://example.com/sqlite",
          "Learn SQLite",
        ),
      ]),
    );
    await runWorker(f.sdk);
    const cases = [
      {
        query: "SQLite composite indexes",
        goal: "Learn SQLite",
        url: "https://example.com/sqlite",
      },
      {
        query: "Tomato seedlings sunlight",
        goal: "Grow tomatoes",
        url: "https://garden.com/tomatoes",
      },
    ];
    for (const sample of cases) {
      const found = queryBrowser(f.sdk, {
        query: sample.query,
        goal: sample.goal,
        from: yesterday - 1,
        to: yesterday + 7200000,
        collectorId: "collector",
        limit: 10,
      });
      expect(found.pages.length).toBeGreaterThan(0);
      expect(found.pages.every((page) => page.url === sample.url)).toBe(true);
      expect(found.threads).toHaveLength(1);
      expect(found.sessions.length).toBeGreaterThan(0);
    }
    const databaseGoal = queryBrowser(f.sdk, { goal: "Learn SQLite" });
    expect(databaseGoal.threads).toHaveLength(1);
    expect(databaseGoal.sessions).toHaveLength(2);
    expect(
      queryBrowser(f.sdk, { goal: "Learn SQLite", from: Date.now() }).pages,
    ).toEqual([]);
  } finally {
    f.database.close();
  }
});
