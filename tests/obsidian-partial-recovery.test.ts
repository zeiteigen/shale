import { expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createExtensionSDK } from "../sdk";
import { createTestDatabase } from "./fixtures/database";
import { prepareVault } from "../extensions/obsidian/process-vaults";
import { run as recover } from "../extensions/obsidian/recover";

it("rescans older unfinished files after recovery of an interrupted preparation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "partial-vault-"));
  const database = createTestDatabase();
  const sdk = createExtensionSDK("obsidian parser", { database });
  const older = join(directory, "Unfinished.md");
  const newer = join(directory, "Recovered.md");
  const vault = { id: "vault", name: "Vault", path: directory };
  try {
    writeFileSync(older, "# Unfinished\nOriginal material");
    writeFileSync(newer, "# Recovered\nCached material");
    utimesSync(older, 100, 100);
    utimesSync(newer, 200, 200);
    sdk.state.setWatermark("50000", `vault:${directory}:mtime`);
    sdk.saveCheckpoint({
      type: "ai_summary", vault, mtime: 200000,
      parsedFile: { noteTitle: "Recovered", noteUri: `file://${newer}`, updatedAt: 200000, contextualChunks: [{ chunk_index: 0, text_content: "Cached material" }] },
    }, { id: `ai_summary:${newer}` });
    sdk.queryLLM = (async () => "Expanded material") as any;
    await recover(sdk);
    expect(sdk.state.getWatermark(`vault:${directory}:mtime`)).toBe("50000");
    const prepared = await prepareVault(vault, sdk);
    expect(prepared.parsedNotes.map((note) => note.filePath)).toContain(older);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
