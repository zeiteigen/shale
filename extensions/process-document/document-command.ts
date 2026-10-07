/** Bound native parsing commands and stop their children on cancellation. */
export async function documentCommand(args: string[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const child = Bun.spawn(args, { stdout: "ignore", stderr: "pipe", env: { ...process.env, OMP_THREAD_LIMIT: "1" } });
  const kill = () => { try { child.kill(); } catch {} };
  const deadline = setTimeout(kill, 30_000);
  signal.addEventListener("abort", kill, { once: true });
  try {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    signal.throwIfAborted();
    if (code !== 0) throw new Error(`${args[0]} failed: ${stderr.trim() || `exit ${code}`}`);
  } finally { clearTimeout(deadline); signal.removeEventListener("abort", kill); }
}
