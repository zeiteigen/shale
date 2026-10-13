import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ChatMessage } from "@shale/sdk/chat/types";
import type { EmailSettings } from "./settings.types";

export interface EmailRecord { subject: string; references: string[]; message: ChatMessage }
/** `uid` is the highest committed UID; `gaps` are older [lo, hi] UID ranges still to backfill, newest first. */
export interface MailboxCursor { uidValidity: string; uid: number; gaps?: Array<[number, number]> }
export interface EmailAccount { host: string; port: number; username: string; password: string }
export type ReaderEvent =
  | { type: "message"; record: EmailRecord; mailbox?: string; uidValidity?: string; uid?: number; gapBelow?: number; gap?: number }
  | { type: "gap-done"; mailbox: string; uidValidity: string; gap: number }
  | { type: "mailbox"; mailbox: string; uidValidity: string }
  | { type: "verified" }
  | { type: "done" }
  | { type: "error"; message: string; mailbox?: string };

export type ReaderRequest =
  | { action: "import"; path: string }
  | { action: "verify"; account: EmailAccount; mailboxes: string[] }
  | { action: "sync"; account: EmailAccount; mailboxes: string[]; cursors: Record<string, MailboxCursor | null>;
      initialSyncDays: number; maxMessagesPerMailbox: number };

/** Stream one message at a time, acknowledging only after the caller persists it. Secrets travel on stdin. */
export async function* readerEvents(settings: EmailSettings, request: ReaderRequest): AsyncGenerator<ReaderEvent> {
  const child = spawn(settings.pythonBin || "python3", [join(import.meta.dir, "sidecar", "reader.py")],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  let processError: Error | undefined;
  const exited = new Promise<number | null>(resolve => {
    child.once("error", error => { processError = error; });
    child.once("close", resolve);
  });
  child.stderr.resume(); // Drain diagnostic output without exposing credentials or mail contents.
  child.stdin.on("error", () => {}); // Writes surface their errors through the callback below.
  const send = (line: string) => new Promise<void>((resolve, reject) => {
    child.stdin.write(line, error => error ? reject(error) : resolve());
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, (settings.syncTimeoutMinutes ?? 10) * 60_000);
  let done = false;
  try {
    await send(`${JSON.stringify(request)}\n`);
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line) as ReaderEvent;
        if (!["message", "mailbox", "gap-done", "verified", "done", "error"].includes(event.type))
          throw new Error("Email reader returned an invalid event.");
        if (event.type === "done") done = true;
        yield event;
        if (event.type === "message") {
          await send("ack\n");
        }
      }
    }
    buffered += decoder.decode();
    const code = await exited;
    if (timedOut) throw new Error("Email reader timed out; committed messages will resume on the next run.");
    if (processError) throw new Error(`Could not start the email reader: ${processError.message}`);
    if (code !== 0 || !done || buffered.trim()) throw new Error(`Email reader did not finish successfully (exit ${code}).`);
  } finally {
    clearTimeout(timer);
    try { child.stdin.end(); } catch { /* already closed */ }
    if (child.exitCode === null) child.kill();
    await exited;
  }
}
