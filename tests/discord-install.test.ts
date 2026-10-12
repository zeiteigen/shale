import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { installPackage } from "../extensions/discord/install-package";

let directory: string;
let binary: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "shale-dce-install-"));
  const installed = join(directory, "dce");
  mkdirSync(installed);
  binary = join(installed, "DiscordChatExporter.Cli");
  writeFileSync(binary, "previous working binary");
  writeFileSync(join(installed, ".version"), "old version\n");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it("keeps the previous exporter when downloading or extracting the replacement fails", async () => {
  const brokenDownload = new Response(new ReadableStream({ start(controller) { controller.error(new Error("download interrupted")); } }));
  await expect(installPackage(brokenDownload, binary, "new version")).rejects.toThrow("download interrupted");
  await expect(installPackage(new Response("invalid zip"), binary, "new version")).rejects.toThrow("Extracting the archive failed");
  expect(await Bun.file(binary).text()).toBe("previous working binary");
  expect(await Bun.file(join(directory, "dce", ".version")).text()).toBe("old version\n");
  expect(readdirSync(directory)).toEqual(["dce"]);
});

it.skipIf(process.platform === "win32")("replaces the exporter only after it runs successfully", async () => {
  const packageFor = (script: string) => new Response(zipSync({ "DiscordChatExporter.Cli": strToU8(script) }));
  await expect(installPackage(packageFor("#!/bin/sh\nexit 1\n"), binary, "new version")).rejects.toThrow("The exporter does not run");
  expect(await Bun.file(binary).text()).toBe("previous working binary");
  const script = "#!/bin/sh\nprintf 'v2.48.0\\n'\n";
  expect(await installPackage(packageFor(script), binary, "2.48 linux-x64")).toBe("v2.48.0");
  expect(await Bun.file(binary).text()).toBe(script);
  expect(await Bun.file(join(directory, "dce", ".version")).text()).toBe("2.48 linux-x64\n");
  expect(readdirSync(directory)).toEqual(["dce"]);
});
