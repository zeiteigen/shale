import { expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCandidates, handleCliCommand } from "../main/cli";

it("supports root settings in daemon commands and dynamic completion", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shale-root-daemon-"));
  try {
    mkdirSync(join(rootDir, "extensions"));
    mkdirSync(join(rootDir, "data"));
    writeFileSync(join(rootDir, "package.json"), '{"name":"root-daemon-test"}');
    writeFileSync(join(rootDir, "data/settings.json"), '{"OPENAI_CHAT_CONCURRENCY":4}');
    writeFileSync(join(rootDir, "data/settings.help.json"), readFileSync(join(import.meta.dir, "../data/settings.help.json")));
    const options = { rootDir, crons: [] };
    expect((await handleCliCommand("settings list-targets", options)).output).toContain("root");
    expect((await handleCliCommand("settings get root OPENAI_CHAT_CONCURRENCY", options)).output).toBe("4");
    expect((await handleCliCommand("settings set root OPENAI_CHAT_CONCURRENCY 7", options)).success).toBe(true);
    expect((await handleCliCommand("settings get root OPENAI_CHAT_CONCURRENCY", options)).output).toBe("7");
    expect(buildCandidates(options)).toContain("settings set root OPENAI_CHAT_BATCH_MODE api");
    expect(buildCandidates(options)).toContain("settings get root OPENAI_CHAT_CONCURRENCY");
    expect(buildCandidates(options).some(candidate => candidate.includes("OPENAI_API_KEY"))).toBe(false);
    expect((await handleCliCommand("settings describe root MODEL_BATCH_TIMEOUT_MS", options)).output).toContain("86460000");
    expect((await handleCliCommand("settings reset root OPENAI_CHAT_CONCURRENCY", options)).success).toBe(true);
    expect((await handleCliCommand("settings get root OPENAI_CHAT_CONCURRENCY", options)).output).toBe("4");
    expect((await handleCliCommand("settings set root OPENAI_CHAT_CONCURRENCY 0", options)).success).toBe(false);
    expect((await handleCliCommand("settings set root OPENAI_API_KEY secret", options)).success).toBe(false);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
