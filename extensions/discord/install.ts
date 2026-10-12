/**
 * Downloads the self-contained DiscordChatExporter CLI into `data/discord/dce`,
 * which the extension uses automatically. Run via `bun run setup discord`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DCE_DIR, DCE_BINARY, DCE_VERSION } from "./dce-binary";
import { installPackage } from "./install-package";

const platforms: Record<string, string> = {
  "linux-x64": "linux-x64", "linux-arm64": "linux-arm64", "linux-arm": "linux-arm",
  "darwin-x64": "osx-x64", "darwin-arm64": "osx-arm64", "win32-x64": "win-x64", "win32-arm64": "win-arm64",
};

const version = process.env.DCE_VERSION || DCE_VERSION;
const target = platforms[`${process.platform}-${process.arch}`];
if (!target) throw new Error(`No DiscordChatExporter CLI build for ${process.platform}-${process.arch}; install it yourself and set dceCommand.`);

const marker = join(DCE_DIR, ".version");
if (existsSync(DCE_BINARY) && existsSync(marker) && (await Bun.file(marker).text()).trim() === `${version} ${target}`) {
  console.log(`DiscordChatExporter ${version} is already installed: ${DCE_BINARY}`);
  process.exit(0);
}

const url = `https://github.com/Tyrrrz/DiscordChatExporter/releases/download/${version}/DiscordChatExporter.Cli.${target}.zip`;
console.log(`Downloading ${url}`);
const response = await fetch(url);
if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
const installed = await installPackage(response, DCE_BINARY, `${version} ${target}`);
console.log(`DiscordChatExporter ${installed} ready: ${DCE_BINARY}`);
