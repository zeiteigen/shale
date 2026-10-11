import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { resolveDataPath } from "@shale/sdk/chat/paths";
import { INSTAGRAM_DEFAULTS, type InstagramSettings } from "./settings.types";

export const SIDECAR_SCRIPT = join(import.meta.dir, "sidecar", "ig_sync.py");
/** Virtualenv created by `bun run setup instagram` (install.ts). */
export const VENV_DIR = resolveDataPath("./data/instagram/venv");
export const VENV_PYTHON = join(VENV_DIR, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

/** An explicit pythonBin wins; otherwise the setup virtualenv, then the system python3. */
export function pythonBin(settings: InstagramSettings) {
  return settings.pythonBin?.trim() || (existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3");
}

export function sessionPath(settings: InstagramSettings) {
  return resolveDataPath(settings.sessionFile || INSTAGRAM_DEFAULTS.sessionFile);
}

/** A running sidecar speaking JSON lines: write requests to stdin, await events from stdout. */
export class SidecarProcess {
  readonly child: Subprocess<"pipe", "pipe", "pipe">;
  private queue: unknown[] = [];
  private waiters: Array<(event: unknown) => void> = [];
  private ended = false;
  readonly stderr: Promise<string>;

  constructor(settings: InstagramSettings, args: string[], env: Record<string, string | undefined> = {}) {
    this.child = Bun.spawn([pythonBin(settings), SIDECAR_SCRIPT, "--session", sessionPath(settings), ...args], {
      env: { ...process.env, ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    this.stderr = new Response(this.child.stderr).text();
    void this.pump();
  }

  private push(event: unknown) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(event); else this.queue.push(event);
  }

  private async pump() {
    const decoder = new TextDecoder();
    let buffered = "";
    const handle = (line: string) => {
      if (!line.trim()) return;
      try { this.push(JSON.parse(line)); } catch { /* ignore non-protocol output */ }
    };
    try {
      for await (const chunk of this.child.stdout) {
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        lines.forEach(handle);
      }
      handle(buffered + decoder.decode());
    } finally {
      this.ended = true;
      const code = await this.child.exited;
      const detail = (await this.stderr).trim().split("\n").slice(-3).join(" ");
      while (this.waiters.length) this.push({ type: "exit", code, detail });
      this.queue.push({ type: "exit", code, detail });
    }
  }

  /** Next protocol event; `{type: "exit"}` once the process has finished. */
  next(timeoutMs: number): Promise<any> {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.ended) return Promise.resolve({ type: "exit", code: this.child.exitCode });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(waiter => waiter !== done);
        reject(new Error("Instagram did not respond in time."));
      }, timeoutMs);
      const done = (event: unknown) => { clearTimeout(timer); resolve(event); };
      this.waiters.push(done);
    });
  }

  send(value: unknown) {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
    this.child.stdin.flush();
  }

  close() {
    try { this.child.stdin.end(); } catch { /* already closed */ }
  }

  kill() {
    this.close();
    if (this.child.exitCode === null) this.child.kill();
  }
}
