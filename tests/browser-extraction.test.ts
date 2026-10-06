import { expect, it } from "bun:test";
import { parseHtmlSnapshot } from "../extensions/web-page-parser/readability";
import { chunkBlocks } from "../extensions/web-page-parser/chunk-blocks";
import { validateBrowserPayload } from "../lib/browser-validation";
import { browserFixture, capture } from "./fixtures/browser-connector";
import { parseWebPage } from "../extensions/web-page-parser/parser";
it("retains code, tables, repeated evidence and heading locations while removing clutter", () => {
  const html =
    '<html><body><nav>Menu links</nav><aside>Ads</aside><main><h1>Database guide</h1><h2>Queries</h2><p>Repeated meaningful statement.</p><p>Repeated meaningful statement.</p><pre>SELECT *\n  FROM items;\nSELECT *\n  FROM items;</pre><table><tr><th>Name</th><th>Cost</th></tr><tr><td>Index</td><td>2</td></tr></table><p hidden>Secret</p><form><input value="sensitive"></form><img data-src="/diagram.png" alt="Index diagram"></main></body></html>';
  const parsed = parseHtmlSnapshot(html, "https://example.com/docs");
  expect(parsed.text).not.toContain("Menu links");
  expect(parsed.text).not.toContain("Secret");
  expect(parsed.text.match(/Repeated meaningful statement/g)).toHaveLength(2);
  expect(parsed.text).toContain("SELECT *\n  FROM items");
  expect(parsed.blocks.find((b) => b.kind === "table")?.text).toBe(
    "Name\tCost\nIndex\t2",
  );
  expect(parsed.images[0]?.url).toBe("https://example.com/diagram.png");
  const chunks = chunkBlocks(parsed.blocks, 40);
  expect(chunks.every((chunk) => chunk.text.length <= 40)).toBe(true);
  expect(chunks.some((chunk) => chunk.headingPath.includes("Queries"))).toBe(
    true,
  );
  expect(parsed.html).not.toContain("input");
  expect(parsed.html).not.toContain("script");
});
it("reports truncation and produces a wire-valid bounded snapshot", () => {
  const parsed = parseHtmlSnapshot(
    `<main><h1>Bounded</h1>${"<p>Long retained paragraph about database indexing.</p>".repeat(1000)}</main>`,
    "https://example.com",
    500,
  );
  expect(parsed.extraction.truncated).toBe(true);
  expect(parsed.extraction.originalChars).toBeGreaterThan(500);
  expect(parsed.text.length).toBeLessThanOrEqual(500);
  expect(() =>
    validateBrowserPayload({
      ...capture("a"),
      ...parsed,
      textContent: parsed.text,
    }),
  ).not.toThrow();
});
it("repairs weak supplied text with useful HTML and disables chat and vision independently", async () => {
  const f = browserFixture();
  try {
    let calls = 0;
    f.sdk.queryLLM = async () => {
      calls++;
      throw new Error("Unexpected chat");
    };
    f.sdk.messages.handle(
      "file:process",
      async () => {
        calls++;
        throw new Error("Unexpected vision");
      },
      { name: "process-image" },
    );
    const parsed = await parseWebPage(f.sdk, {
      url: "https://example.com/docs",
      textContent: "Menu Login",
      html: `<main><h1>Database indexes</h1><p>${"SQLite index evidence. ".repeat(20)}</p><img src="/figure.png"></main>`,
      enableLlmContext: false,
      includeImages: false,
    });
    expect(parsed.text).toContain("SQLite index evidence");
    expect(parsed.blocks?.length).toBeGreaterThan(0);
    expect(parsed.extraction?.quality).toBe("full");
    expect(calls).toBe(0);
  } finally {
    f.database.close();
  }
});
