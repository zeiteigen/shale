import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Validate the new package before replacing a working installation. */
export async function installPackage(response: Response, binaryPath: string, versionMarker: string): Promise<string> {
  const directory = dirname(binaryPath);
  mkdirSync(dirname(directory), { recursive: true });
  const staging = mkdtempSync(join(dirname(directory), ".dce-install-"));
  const unpacked = join(staging, "new");
  const previous = join(staging, "previous");
  let keepPrevious = false;
  try {
    mkdirSync(unpacked);
    const archive = join(staging, "dce.zip");
    await Bun.write(archive, response);
    const extractors = [["unzip", "-q", "-o", archive, "-d", unpacked], ["bsdtar", "-xf", archive, "-C", unpacked],
      ["python3", "-m", "zipfile", "-e", archive, unpacked]];
    const extractor = extractors.find(([command]) => Bun.which(command!));
    if (!extractor) throw new Error("Need unzip, bsdtar, or python3 to extract the archive.");
    const extracted = Bun.spawnSync(extractor, { stdout: "pipe", stderr: "pipe" });
    if (extracted.exitCode !== 0) throw new Error(`Extracting the archive failed: ${extracted.stderr.toString().trim()}`);
    const binary = join(unpacked, basename(binaryPath));
    if (!existsSync(binary)) throw new Error(`The archive did not contain ${basename(binaryPath)}.`);
    if (process.platform !== "win32") chmodSync(binary, 0o755);
    const check = Bun.spawnSync([binary, "--version"]);
    if (check.exitCode !== 0) throw new Error(`The exporter does not run: ${check.stderr.toString().trim()}`);
    await Bun.write(join(unpacked, ".version"), `${versionMarker}\n`);
    if (existsSync(directory)) renameSync(directory, previous);
    try {
      renameSync(unpacked, directory);
    } catch (error) {
      if (existsSync(previous)) {
        // If rollback itself fails, retain the old package for recovery.
        keepPrevious = true;
        renameSync(previous, directory);
        keepPrevious = false;
      }
      throw error;
    }
    return check.stdout.toString().trim();
  } finally {
    if (!keepPrevious) rmSync(staging, { recursive: true, force: true });
  }
}
