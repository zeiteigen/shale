import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  prepareVault,
  finalizeVault,
  expandNoteWithChatModel,
} from "../extensions/obsidian/process-vaults";
import type { VaultInfo } from "../extensions/obsidian/vault-finder";
import { testEmbeddings } from "./fixtures/embedding";
import { run as recover } from "../extensions/obsidian/recover";
import { createExtensionSDK } from "../sdk";
import { isTExtensionManifest } from "../lib/extension";
import { clearAllCheckpoints, hasQueuedCheckpoints } from "../lib/db";
import { runCron } from "../main/index";

describe("Obsidian Extension AI Summary Checkpoints & Recovery", () => {
  const extensionId = "obsidian parser";
  const originalTimeout = process.env.EMBEDDING_TIMEOUT_MS;

  beforeEach(() => {
    clearAllCheckpoints(extensionId);
    process.env.EMBEDDING_TIMEOUT_MS = "100";
  });

  afterEach(() => {
    if (originalTimeout !== undefined) {
      process.env.EMBEDDING_TIMEOUT_MS = originalTimeout;
    } else {
      delete process.env.EMBEDDING_TIMEOUT_MS;
    }
  });

  it("manifest.json includes valid checkpoint_recover script", () => {
    const manifestPath = join(
      import.meta.dir,
      "../extensions/obsidian/manifest.json",
    );
    const content = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(isTExtensionManifest(content)).toBe(true);
    expect(content.checkpoint_recover).toBe("recover.ts");
  });

  it("saves a checkpoint during Phase 1 AI summary generation", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "obsidian-cp-test-"));
    const notePath = join(tempDir, "Quantum.md");

    writeFileSync(
      notePath,
      `---
category: Physics
---
# Quantum Computing
Short note on qubits and superposition.`,
    );

    const vault: VaultInfo = {
      id: "test-v1",
      name: "Test Vault",
      path: tempDir,
    };

    let queryLLMCalled = false;
    const mockSdk = createExtensionSDK(extensionId, "obsidian");
    mockSdk.queryLLM = (async () => {
      queryLLMCalled = true;
      return "Qubits; superposition; decoherence time; quantum gates.";
    }) as any;

    expect(mockSdk.hasCheckpoints()).toBe(false);

    // Run Phase 1: prepareVault (Chat model operations)
    const prepared = await prepareVault(vault, mockSdk, true);

    expect(queryLLMCalled).toBe(true);
    expect(prepared.parsedNotes.length).toBe(1);

    // Verify checkpoint was saved during AI summary generation
    expect(mockSdk.hasCheckpoints()).toBe(true);
    const checkpoints = mockSdk
      .getCheckpoints()
      .filter((cp) => cp.data.type === "ai_summary");
    expect(checkpoints.length).toBe(1);
    expect(checkpoints[0].data.type).toBe("ai_summary");
    expect(checkpoints[0].data.noteTitle).toBe("Quantum");

    // The contextual chunks should include the AI summary expansion
    const hasExpandedChunk = checkpoints[0].data.parsedFile.chunks.some(
      (c: any) => c.heading?.includes("(Expanded Context)"),
    );
    expect(hasExpandedChunk).toBe(true);
  });

  it("reuses checkpointed AI summary if available instead of querying LLM", async () => {
    const mockSdk = createExtensionSDK(extensionId, "obsidian");

    // Pre-seed an AI summary checkpoint
    mockSdk.saveCheckpoint(
      {
        type: "ai_summary",
        noteTitle: "Precached Note",
        summary: "Cached AI summary content from checkpoint.",
      },
      {
        id: "ai_summary:Precached Note",
        key: "ai_summary:Precached Note",
      },
    );

    let llmQueried = false;
    mockSdk.queryLLM = (async () => {
      llmQueried = true;
      return "Fresh summary from LLM";
    }) as any;

    const result = await expandNoteWithChatModel(
      mockSdk,
      "Precached Note",
      "Short note content.",
    );

    expect(llmQueried).toBe(false);
    expect(result).toBe("Cached AI summary content from checkpoint.");
  });

  it("deletes checkpoints upon successful Phase 2 finalization", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "obsidian-finalize-cp-"));
    const notePath = join(tempDir, "Note.md");

    writeFileSync(notePath, "# Note\nAtomic note.");

    const vault: VaultInfo = {
      id: "test-v2",
      name: "Vault 2",
      path: tempDir,
    };

    const mockSdk = createExtensionSDK(extensionId, "obsidian");
    mockSdk.queryLLM = (async () => "AI summary text") as any;
    mockSdk.embed = (async (texts: any) =>
      testEmbeddings(Array.isArray(texts) ? texts.length : 1, 4096)) as any;

    // Phase 1: prepareVault creates checkpoint
    const prepared = await prepareVault(vault, mockSdk, true);
    expect(mockSdk.hasCheckpoints()).toBe(true);

    // Phase 2: finalizeVault ingests and clears checkpoint
    await finalizeVault(prepared, mockSdk);
    expect(mockSdk.hasCheckpoints()).toBe(false);
  });

  it("retains failed embeddings and their watermark, then recovers without another chat call", async () => {
    const path = mkdtempSync(join(tmpdir(), "obsidian-embedding-retry-"));
    writeFileSync(join(path, "Retry.md"), "# Retry\nAn atomic note.");
    const sdk = createExtensionSDK(extensionId, "obsidian");
    let chatCalls = 0;
    sdk.queryLLM = (async () => {
      chatCalls++;
      return "Cached expansion.";
    }) as any;
    sdk.embed = (async () => {
      throw new Error("Embedding endpoint offline");
    }) as any;
    const prepared = await prepareVault(
      { id: "retry", name: "Retry vault", path },
      sdk,
      true,
    );
    await expect(finalizeVault(prepared, sdk)).rejects.toThrow(
      "watermark retained",
    );
    expect(sdk.hasCheckpoints()).toBe(true);
    expect(sdk.state.getWatermark(`vault:${path}:mtime`)).toBeNull();
    await expect(recover(sdk)).rejects.toThrow("recovery failed");
    expect(sdk.hasCheckpoints()).toBe(true);
    sdk.embed = (async (texts: string[]) =>
      testEmbeddings(texts.length)) as any;
    await recover(sdk);
    expect(chatCalls).toBe(1);
    expect(sdk.hasCheckpoints()).toBe(false);
    expect(
      Number(sdk.state.getWatermark(`vault:${path}:mtime`)),
    ).toBeGreaterThan(0);
  });

  it("recovers uncommitted AI summaries via recover.ts, ingests into DB, and advances watermark", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "obsidian-recover-test-"));
    const notePath = join(tempDir, "DeepLearning.md");

    writeFileSync(
      notePath,
      `---
category: AI
---
# Deep Learning
Backpropagation and transformers.`,
    );

    const vault: VaultInfo = {
      id: "test-v3",
      name: "AI Vault",
      path: tempDir,
    };

    let llmCalls = 0;
    const mockSdk = createExtensionSDK(extensionId, "obsidian");
    mockSdk.queryLLM = (async () => {
      llmCalls++;
      return "Backpropagation; Adam optimizer; Transformer attention heads; Gradient descent.";
    }) as any;
    mockSdk.embed = (async (texts: any) =>
      testEmbeddings(Array.isArray(texts) ? texts.length : 1, 4096)) as any;

    // Simulate Phase 1 running and saving checkpoint
    await prepareVault(vault, mockSdk, true);
    expect(llmCalls).toBe(1);
    expect(mockSdk.hasCheckpoints()).toBe(true);

    // SIMULATE CRASH: Process died before Phase 2 ran!
    // Now execute recovery script
    const recoveryResult = await recover(mockSdk);
    expect(recoveryResult.recoveredNotes).toBe(1);

    // Verify checkpoints are now cleared
    expect(mockSdk.hasCheckpoints()).toBe(false);

    // Verify watermark was advanced for this vault
    const watermarkKey = `vault:${tempDir}:mtime`;
    const watermark = Number(mockSdk.state.getWatermark(watermarkKey) ?? "0");
    expect(watermark).toBeGreaterThan(0);

    // Verify note is committed to the database
    const chunks = mockSdk.context.hydrate(`file://${notePath}`, 10);
    expect(chunks.chunks.length).toBeGreaterThan(0);
    expect(chunks.combinedText).toContain("Backpropagation");

    // Now if Phase 1 runs again:
    // It should check the watermark and skip the note (0 new LLM calls!)
    const initialLlmCalls = llmCalls;
    const nextPrepared = await prepareVault(vault, mockSdk, false);
    expect(nextPrepared.parsedNotes.length).toBe(0);
    expect(llmCalls).toBe(initialLlmCalls); // Zero new LLM calls!
  });

  it("automatically delays crons and runs recover.ts before cron execution via runCron", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "obsidian-cron-rec-"));
    const notePath = join(tempDir, "NeuralNets.md");
    const executionOrder: string[] = [];

    writeFileSync(notePath, "# Neural Nets\nPerceptron and multilayer nets.");

    const vault: VaultInfo = {
      id: "test-v4",
      name: "NN Vault",
      path: tempDir,
    };

    const mockSdk = createExtensionSDK(extensionId, "obsidian");
    mockSdk.queryLLM = (async () =>
      "Perceptron; Activation functions; Weights.") as any;
    mockSdk.embed = (async (texts: any) =>
      testEmbeddings(Array.isArray(texts) ? texts.length : 1, 4096)) as any;

    // Prepare note to create checkpoint
    await prepareVault(vault, mockSdk, true);
    expect(hasQueuedCheckpoints(extensionId)).toBe(true);

    // Create a custom cron script that checks that checkpoints were recovered before it ran
    const cronScriptPath = join(tempDir, "cron-runner.ts");
    writeFileSync(
      cronScriptPath,
      `
      import { hasQueuedCheckpoints } from "${join(import.meta.dir, "../lib/db")}";
      export async function run(sdk: any) {
        // Recovery must have finished and cleared the queue before this cron runs
        const hasQueued = hasQueuedCheckpoints("${extensionId}");
        (globalThis as any).cronExecutionResult = {
          hasQueuedDuringCron: hasQueued,
          extensionId: sdk.extensionId,
        };
      }
      `,
    );

    const cron = {
      name: "obsidian-cron-test",
      schedule: "0 0 * * *",
      script: cronScriptPath,
      extensionId,
      namespace: "obsidian",
    };

    await runCron(cron, mockSdk);

    // Verify recovery ran first and cron ran right after
    const result = (globalThis as any).cronExecutionResult;
    expect(result).toBeDefined();
    expect(result.hasQueuedDuringCron).toBe(false);
    expect(result.extensionId).toBe(extensionId);

    // Checkpoints should remain cleared
    expect(hasQueuedCheckpoints(extensionId)).toBe(false);
  });
});
