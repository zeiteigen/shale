/**
 * Installs the instagrapi sidecar's Python dependencies into a private virtualenv
 * (`data/instagram/venv`), which the extension uses automatically.
 * Run via `bun run setup instagram`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VENV_PYTHON, VENV_DIR } from "./sidecar-process";

const requirements = join(import.meta.dir, "sidecar", "requirements.txt");

async function sh(command: string[]) {
  console.log(`$ ${command.join(" ")}`);
  const child = Bun.spawn(command, { stdio: ["inherit", "inherit", "inherit"] });
  if (await child.exited !== 0) throw new Error(`Command failed: ${command.join(" ")}`);
}

function findPython() {
  for (const candidate of ["python3", "python"]) {
    const path = Bun.which(candidate);
    if (!path) continue;
    const check = Bun.spawnSync([path, "-c", "import sys, venv; sys.exit(0 if sys.version_info >= (3, 9) else 1)"]);
    if (check.exitCode === 0) return path;
  }
  throw new Error("Python 3.9+ with the venv module is required. Install it with your system package manager and run setup again.");
}

if (!existsSync(VENV_PYTHON)) await sh([findPython(), "-m", "venv", VENV_DIR]);
await sh([VENV_PYTHON, "-m", "pip", "install", "--disable-pip-version-check", "--upgrade", "pip"]);
await sh([VENV_PYTHON, "-m", "pip", "install", "--disable-pip-version-check", "-r", requirements]);
await sh([VENV_PYTHON, "-c", "import instagrapi; print('instagrapi', instagrapi.__version__ if hasattr(instagrapi, '__version__') else 'installed')"]);
console.log(`Instagram sidecar ready: ${VENV_PYTHON}`);
