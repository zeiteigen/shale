import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SettingsManager,
  createExtensionSDK,
  runWithSDK,
  settings,
  getSettings,
  getSetting,
} from "../sdk";
import type { ObsidianSettings } from "../extensions/obsidian/settings.types";
import { discoverVaults } from "../extensions/obsidian/vault-finder";
import { dynamicChunkNote } from "../extensions/obsidian/chunker";
import { isImageFile } from "../extensions/obsidian/parser";
import { calculateDynamicTargetTokens } from "../extensions/obsidian/parse-file";

describe("SDK Settings Management & Hot Reloading", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("reads settings fresh from disk on every invocation without caching", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "shale-settings-"));
    tempDirs.push(tempDir);
    const settingsPath = join(tempDir, "settings.json");

    // Initially write version 1
    writeFileSync(
      settingsPath,
      JSON.stringify({
        atomicNoteCharLimit: 500,
        expandAtomicNotes: true,
        namespace: "custom-obsidian",
      }),
    );

    const manager = new SettingsManager<ObsidianSettings>(tempDir);

    // Initial read
    expect(manager.get("atomicNoteCharLimit", 600)).toBe(500);
    expect(manager.get("expandAtomicNotes", false)).toBe(true);
    expect(manager.get("namespace", "default")).toBe("custom-obsidian");

    // Modify settings on disk without restarting
    writeFileSync(
      settingsPath,
      JSON.stringify({
        atomicNoteCharLimit: 850,
        expandAtomicNotes: false,
        namespace: "updated-namespace",
      }),
    );

    // Immediate read reflects the updated on-disk value
    expect(manager.get("atomicNoteCharLimit", 600)).toBe(850);
    expect(manager.get("expandAtomicNotes", true)).toBe(false);
    expect(manager.get("namespace", "default")).toBe("updated-namespace");
    expect(manager.getAll().atomicNoteCharLimit).toBe(850);
  });

  it("gracefully returns default values when settings.json does not exist", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "empty-settings-"));
    tempDirs.push(emptyDir);

    const manager = new SettingsManager<ObsidianSettings>(emptyDir);

    expect(manager.getAll<Record<string, unknown>>()).toEqual({});
    expect(manager.get("atomicNoteCharLimit", 600)).toBe(600);
    expect(manager.get("expandAtomicNotes", true)).toBe(true);
    expect(manager.has("nonExistentKey")).toBe(false);
  });

  it("handles malformed JSON on disk gracefully without crashing", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "malformed-settings-"));
    tempDirs.push(tempDir);
    const settingsPath = join(tempDir, "settings.json");

    // Write corrupted JSON (e.g. user currently editing)
    writeFileSync(settingsPath, "{ corrupted json: ");

    const manager = new SettingsManager<ObsidianSettings>(tempDir);

    // Should return fallback defaults instead of throwing syntax error
    expect(manager.getAll<Record<string, unknown>>()).toEqual({});
    expect(manager.get("atomicNoteCharLimit", 600)).toBe(600);

    // Fix JSON on disk
    writeFileSync(settingsPath, JSON.stringify({ atomicNoteCharLimit: 750 }));

    // Immediately recovers
    expect(manager.get("atomicNoteCharLimit", 600)).toBe(750);
  });

  it("supports ShaleSDK settings property and ambient scope proxy", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sdk-ambient-settings-"));
    tempDirs.push(tempDir);
    const settingsPath = join(tempDir, "settings.json");

    writeFileSync(
      settingsPath,
      JSON.stringify({
        describeImages: false,
        customPrompt: "My custom prompt",
      }),
    );

    const sdk = createExtensionSDK("test-ext", { namespace: "test-ns", extensionDir: tempDir });

    expect(sdk.settings).toBeInstanceOf(SettingsManager);
    expect(sdk.settings.get("describeImages", true)).toBe(false);
    expect(sdk.settings.get("customPrompt", "")).toBe("My custom prompt");

    await runWithSDK(sdk, async () => {
      // Dynamic proxy settings
      expect(settings.get("describeImages", true)).toBe(false);
      expect(settings.get("customPrompt", "")).toBe("My custom prompt");

      // Convenience functions getSettings and getSetting
      expect(getSetting("describeImages", true)).toBe(false);
      expect(getSetting("customPrompt", "")).toBe("My custom prompt");
      expect(getSettings<{ describeImages: boolean }>().describeImages).toBe(
        false,
      );

      // Change on disk within ambient scope
      writeFileSync(
        settingsPath,
        JSON.stringify({
          describeImages: true,
          customPrompt: "Prompt v2",
        }),
      );

      // Instant hot reload
      expect(settings.get("describeImages", false)).toBe(true);
      expect(getSetting("customPrompt", "")).toBe("Prompt v2");
    });
  });

  it("integrates with Obsidian extension components", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "obsidian-integration-"));
    tempDirs.push(tempDir);
    const settingsPath = join(tempDir, "settings.json");

    // Configure custom image extensions and custom vaults
    const fakeVaultDir = join(tempDir, "MyVault");
    mkdirSync(fakeVaultDir, { recursive: true });

    writeFileSync(
      settingsPath,
      JSON.stringify({
        imageExtensions: ["heic", "avif"],
        customVaults: [{ name: "SettingsVault", path: fakeVaultDir }],
        atomicNoteCharLimit: 100,
        dynamicTokenBase: 200,
        dynamicTokenMultiplier: 2.0,
      }),
    );

    const sdk = createExtensionSDK("obsidian parser", { namespace: "obsidian", extensionDir: tempDir });

    runWithSDK(sdk, () => {
      // 1. Vault discovery respects customVaults in settings
      const discovered = discoverVaults(undefined, sdk);
      expect(discovered.length).toBe(1);
      expect(discovered[0].name).toBe("SettingsVault");
      expect(discovered[0].path).toBe(fakeVaultDir);

      // 2. Parser recognizes custom imageExtensions from settings
      expect(isImageFile("photo.heic")).toBe(true);
      expect(isImageFile("photo.avif")).toBe(true);
      // "png" is not in the custom list
      expect(isImageFile("photo.png")).toBe(false);

      // 3. Chunker respects custom atomicNoteCharLimit (100)
      const shortNote = "A".repeat(80);
      const chunksShort = dynamicChunkNote(shortNote, "Short");
      expect(chunksShort.length).toBe(1);

      const longerNote = "A".repeat(150);
      const chunksLonger = dynamicChunkNote(longerNote, "Longer");
      // Over 100 chars, so chunker divides it
      expect(chunksLonger.length).toBeGreaterThan(1);

      // 4. Dynamic target tokens formula uses configured base and multiplier
      const text = "one two three four five"; // 5 words
      // expected: Math.round(200 + 5 * 2.0) = 210
      const targetTokens = calculateDynamicTargetTokens(text, sdk);
      expect(targetTokens).toBe(210);
    });
  });
});
