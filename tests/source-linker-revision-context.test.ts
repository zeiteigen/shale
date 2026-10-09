import { expect, it } from "bun:test";
import { createExtensionSDK } from "../sdk";
import { createTestDatabase } from "./fixtures/database";
import { linkContext } from "../extensions/source-linker/link-context";
import { analyzeSourcePairWithLLM } from "../extensions/source-linker/llm-analyzer";
import { commitLinksToGraph } from "../extensions/source-linker/process-links";

it("analyzes and cites the candidate revision after a source changes", async () => {
  const database = createTestDatabase();
  const sdk = createExtensionSDK("source-linker", { database });
  const ingest = (id: string, text: string) => sdk.ingest.sourceAndChunks({
    source: { id, uri: `test:${id}`, type: "test", origin: "test", title: id },
    chunks: [{ text_content: text }],
  });
  try {
    ingest("a", "Original source wording.");
    ingest("b", "Related original wording.");
    const [sourceA, sourceB] = sdk.context.getAllSources();
    ingest("a", "Replacement text unrelated to the old candidate.");
    let prompt = "";
    sdk.queryLLM = (async (value: string, options: any) => {
      prompt = value;
      expect(options).toMatchObject({ reasoningEffort: "none", maxThinkingTokens: null, maxTokens: 8192 });
      return JSON.stringify({ shouldLink: true, relation: "RELATES_TO", reason: "Related", weight: 0.9 });
    }) as any;
    const link = await analyzeSourcePairWithLLM({ sourceA, sourceB, textScore: 1, matchedChunkIds: [] }, sdk);
    expect(prompt).toContain("Original source wording.");
    expect(prompt).not.toContain("Replacement text");
    expect(link?.evidenceA?.[0]?.quote).toBe("Original source wording.");
    expect(commitLinksToGraph([link!], sdk)).toBeGreaterThan(0);
    expect(database.query("SELECT status FROM graph_claims WHERE method='llm'").all()).toContainEqual({ status: "stale" });
    expect(() => linkContext(sdk, "a", "missing-revision", 3)).toThrow("Missing source-linker revision");
  } finally { database.close(); }
});
