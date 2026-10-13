import { getSDK, type ShaleSDK } from "@shale/sdk";
import { indexChatWindows, withChatLease, type ChatConnector } from "@shale/sdk/chat/commit";
import { accountId, emailAccount, emailMailboxes } from "./account";
import { emailConnector, emailSettings, LAST_SYNC_KEY } from "./connector";
import { ingestEmail } from "./ingest";
import { readerEvents, type EmailAccount, type MailboxCursor } from "./reader";
import type { EmailSettings } from "./settings.types";

export const mailboxCursorKey = (account: EmailAccount, mailbox: string) => `sync:uid:${accountId(account)}:${mailbox}`;

const storedCursor = ({ uidValidity, uid, gaps }: MailboxCursor): MailboxCursor =>
  gaps?.length ? { uidValidity, uid, gaps } : { uidValidity, uid };

/** Advance a cursor past one committed message: head messages must rise, gap messages must fall inside their gap. */
function nextCursor(cursor: MailboxCursor, event: { uid?: number; gap?: number; gapBelow?: number }): MailboxCursor | null {
  const uid = event.uid;
  if (!Number.isSafeInteger(uid)) return null;
  const gaps = (cursor.gaps ?? []).map(([lo, hi]) => [lo, hi] as [number, number]);
  if (event.gap !== undefined) {
    const gap = gaps.find(([lo]) => lo === event.gap);
    if (!gap || uid! < gap[0] || uid! > gap[1]) return null;
    gap[1] = uid! - 1;
    return { ...cursor, gaps: gaps.filter(([lo, hi]) => hi >= lo) };
  }
  if (uid! <= cursor.uid) return null;
  if (event.gapBelow !== undefined) {
    // A skipped range must lie between the previous head and this, the oldest message of the newest batch.
    if (!Number.isSafeInteger(event.gapBelow) || event.gapBelow <= cursor.uid || event.gapBelow > uid!) return null;
    if (event.gapBelow < uid!) gaps.push([event.gapBelow, uid! - 1]);
  }
  return { ...cursor, uid: uid!, gaps };
}

async function syncMailboxes(sdk: ShaleSDK, connector: ChatConnector, settings: EmailSettings) {
  const result = { mailboxes: 0, messages: 0, errors: [] as string[] };
  const account = emailAccount(sdk);
  if (!account) { sdk.logger.log("Email sync: no IMAP account connected; local imports remain available."); return result; }
  const mailboxes = emailMailboxes(sdk);
  const cursors = Object.fromEntries(mailboxes.map(name => [name, sdk.state.getJson<MailboxCursor>(mailboxCursorKey(account, name))]));
  const selected = new Map<string, MailboxCursor>();
  try {
    for await (const event of readerEvents(settings, { action: "sync", account, mailboxes, cursors,
      initialSyncDays: settings.initialSyncDays!, maxMessagesPerMailbox: settings.maxMessagesPerMailbox! })) {
      if (event.type === "error") { result.errors.push(event.message); continue; }
      if (event.type === "mailbox") {
        if (!mailboxes.includes(event.mailbox) || !/^\d+$/.test(event.uidValidity)) throw new Error("Invalid mailbox response from email reader.");
        result.mailboxes++;
        const previous = cursors[event.mailbox];
        const same = previous?.uidValidity === event.uidValidity;
        selected.set(event.mailbox, { uidValidity: event.uidValidity, uid: same ? previous!.uid : 0,
          gaps: same ? (previous!.gaps ?? []).map(([lo, hi]) => [lo, hi] as [number, number]) : [] });
      }
      if (event.type === "gap-done") {
        const cursor = selected.get(event.mailbox);
        if (!cursor || cursor.uidValidity !== event.uidValidity) throw new Error("Email reader returned an invalid UID sequence.");
        cursor.gaps = cursor.gaps!.filter(([lo]) => lo !== event.gap);
        sdk.state.setJson(mailboxCursorKey(account, event.mailbox), storedCursor(cursor));
        continue;
      }
      if (event.type !== "message") continue;
      const cursor = event.mailbox ? selected.get(event.mailbox) : undefined;
      const next = cursor && nextCursor(cursor, event);
      if (!cursor || !next || cursor.uidValidity !== event.uidValidity)
        throw new Error("Email reader returned an invalid UID sequence.");
      // Progress and raw message commit together. The sidecar waits for this commit before fetching more mail.
      const changed = sdk.database.transaction(() => {
        const changed = ingestEmail(sdk, connector, event.record);
        sdk.state.setJson(mailboxCursorKey(account, event.mailbox!), storedCursor(next));
        return changed;
      })();
      selected.set(event.mailbox!, next);
      result.messages += changed;
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  sdk.state.setJson(LAST_SYNC_KEY, { accountId: accountId(account), mailboxes: result.mailboxes,
    messages: result.messages, errors: result.errors.length, finishedAt: Date.now() });
  for (const error of result.errors) sdk.logger.error(`Email sync: ${error}`);
  return result;
}

export async function run(sdkOverride?: ShaleSDK) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const settings = emailSettings(sdk);
  if (settings.syncEnabled === false) { sdk.logger.log("Email sync is disabled."); return null; }
  const connector = emailConnector(sdk, settings);
  return withChatLease(sdk, async () => {
    const synced = await syncMailboxes(sdk, connector, settings);
    const indexed = await indexChatWindows(sdk, connector, settings);
    sdk.logger.log(`Email sync: ${synced.mailboxes} mailbox(es), ${synced.messages} new/edited messages, `
      + `${indexed.indexed} window(s) indexed, ${synced.errors.length + indexed.errors.length} error(s).`);
    return { synced, indexed };
  });
}

if (import.meta.main) run().catch(error => { console.error("Email sync failed:", error); process.exitCode = 1; });
export default run;
