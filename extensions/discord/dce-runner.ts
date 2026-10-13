/** DCE reports partial channel failures on stderr even when it exits successfully. */
export class PartialExportError extends Error {}

/**
 * The useful part of DCE's output: exception messages and failure lists, without the
 * .NET stack frames that follow them (which would otherwise crowd out the reason).
 */
export function summarizeOutput(output: string): string {
  const lines = output.split("\n").map(line => line.trim())
    .filter(line => line && !line.startsWith("at ") && !/^(ERROR|Resolving channel\(s\)\.*|Exporting \d+ channel.*)$/i.test(line))
    .map(line => line.replace(/^DiscordChatExporter\.Core\.Exceptions\.\w+:\s*/, ""));
  return lines.slice(-6).join("\n") || "no output";
}

export class Exporter {
  constructor(private command: string[], private token: string) {}

  async run(args: string[], timeoutMs: number): Promise<string> {
    let child;
    try {
      child = Bun.spawn([...this.command, ...args], {
        // DCE reads DISCORD_TOKEN itself; keep it off process listings.
        env: { ...process.env, DISCORD_TOKEN: this.token, FUCK_RUSSIA: "true" }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("DiscordChatExporter is not installed. Run `bun run setup discord` in the Shale folder.");
      throw error;
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const detail = summarizeOutput(`${stderr}\n${stdout}`.split(this.token).join("***"));
      if (timedOut) throw new Error(`DiscordChatExporter timed out after ${Math.round(timeoutMs / 60_000)} min`);
      if (code !== 0) throw new Error(`DiscordChatExporter exited with ${code}: ${detail}`);
      if (/Failed to export the following channel\(s\):/i.test(stderr))
        throw new PartialExportError(`DiscordChatExporter only partially exported this channel and its threads: ${detail}`);
      return stdout;
    } finally {
      clearTimeout(timer);
    }
  }
}
