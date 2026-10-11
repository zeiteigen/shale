#!/usr/bin/env bun
/**
 * One-time setup: installs JavaScript dependencies, then runs every extension's
 * `install_script` (declared in its manifest) for dependencies Bun can't provide,
 * such as Python packages.
 *
 *   bun run setup                 # everything
 *   bun run setup instagram       # only the named extensions' installers
 *   bun run setup --skip-deps     # skip `bun install`
 */
import { Glob } from "bun";
import { dirname, join } from "node:path";
import { isTExtensionManifest } from "./lib/extension";

const root = import.meta.dir;
const args = process.argv.slice(2);
const only = new Set(args.filter(arg => !arg.startsWith("--")));

async function run(label: string, command: string[], cwd = root) {
  console.log(`\n▸ ${label}`);
  const child = Bun.spawn(command, { cwd, stdio: ["inherit", "inherit", "inherit"] });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
}

const failures: string[] = [];
if (!args.includes("--skip-deps") && !only.size) {
  for (const [label, cwd] of [["Installing dependencies", root], ["Installing web interface dependencies", join(root, "visualizer")]] as const) {
    try { await run(label, [process.execPath, "install"], cwd); }
    catch (error) { failures.push((error as Error).message); }
  }
}

const installers: Array<{ name: string; script: string }> = [];
for await (const file of new Glob("*/manifest.json").scan(join(root, "extensions"))) {
  const path = join(root, "extensions", file);
  const manifest = await Bun.file(path).json().catch(() => null);
  if (!isTExtensionManifest(manifest) || !manifest.install_script) continue;
  if (only.size && !only.has(manifest.name)) continue;
  installers.push({ name: manifest.name, script: join(dirname(path), manifest.install_script) });
}
for (const name of only) if (!installers.some(item => item.name === name)) failures.push(`${name}: no extension with an install_script`);

for (const { name, script } of installers.sort((a, b) => a.name.localeCompare(b.name))) {
  try { await run(`Setting up extension "${name}"`, [process.execPath, script]); }
  catch (error) { failures.push((error as Error).message); }
}

if (failures.length) {
  console.error(`\nSetup finished with ${failures.length} problem(s):\n${failures.map(f => `  ✗ ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`\n✓ Setup complete${installers.length ? ` (${installers.map(i => i.name).join(", ")})` : ""}.`);
