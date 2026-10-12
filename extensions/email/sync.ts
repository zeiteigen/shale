import { getSDK, type ShaleSDK } from "@shale/sdk";
import { indexChatWindows, withChatLease, type ChatConnector } from "@shale/sdk/chat/commit";
import { accountId, emailAccount, emailMailboxes } from "./account";
import { emailConnector, emailSettings, LAST_SYNC_KEY } from "./connector";
import { ingestEmail } from "./ingest";
import { readerEvents, type EmailAccount, type MailboxCursor } from "./reader";
import type { EmailSettings } from "./settings.types";

export const mailboxCursorKey = (account: EmailAccount, mailbox: string) => `sync:uid:${accountId(account)}:${mailbox}`;

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
        selected.set(event.mailbox, { uidValidity: event.uidValidity,
          uid: previous?.uidValidity === event.uidValidity ? previous.uid : 0 });
      }
      if (event.type !== "message") continue;
      const cursor = event.mailbox ? selected.get(event.mailbox) : undefined;
      if (!cursor || cursor.uidValidity !== event.uidValidity || !Number.isSafeInteger(event.uid) || event.uid! <= cursor.uid)
        throw new Error("Email reader returned an invalid UID sequence.");
      // Progress and raw message commit together. The sidecar waits for this commit before fetching more mail.
      const changed = sdk.database.transaction(() => {
        const changed = ingestEmail(sdk, connector, event.record);
        sdk.state.setJson(mailboxCursorKey(account, event.mailbox!), { uidValidity: cursor.uidValidity, uid: event.uid! });
        return changed;
      })();
      cursor.uid = event.uid!;
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
