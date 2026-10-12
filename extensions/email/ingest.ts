import type { ShaleSDK } from "@shale/sdk";
import { chatCheckpointId, type ChatConnector } from "@shale/sdk/chat/commit";
import { chatHash } from "@shale/sdk/chat/hash";
import type { EmailRecord } from "./reader";

const aliasKey = (id: string) => `thread:message:${chatHash(id)}`;
const redirectKey = (id: string) => `thread:redirect:${id}`;

function resolveThread(sdk: ShaleSDK, id: string): string {
  const visited = new Set<string>();
  for (;;) {
    if (visited.has(id)) throw new Error("Email thread mapping contains a cycle.");
    visited.add(id);
    const next = sdk.state.get(redirectKey(id));
    if (!next) return id;
    id = next;
  }
}

/** Backfilled history can change the first message of a window, including zero-duration windows. */
function invalidateWindows(sdk: ShaleSDK, connector: ChatConnector, conversationId: string) {
  const { store } = connector;
  const extension = sdk.extensionId;
  const windows = sdk.database.query<{ window_id: string; source_id: string | null }, [string, string]>(
    `SELECT window_id,source_id FROM ${store.windows} WHERE extension_id=? AND conversation_id=?`).all(extension, conversationId);
  for (const window of windows) {
    if (window.source_id) sdk.database.query("DELETE FROM sources WHERE id=?").run(window.source_id);
    sdk.checkpoint.delete(chatCheckpointId(window.window_id));
  }
  sdk.database.query(`DELETE FROM ${store.windows} WHERE extension_id=? AND conversation_id=?`).run(extension, conversationId);
  sdk.database.query(`UPDATE ${store.conversations} SET dirty=1,scan_from=0 WHERE extension_id=? AND conversation_id=?`)
    .run(extension, conversationId);
}

/** Join partial threads when a late parent links them. Only connector-owned local data changes. */
function mergeThread(sdk: ShaleSDK, connector: ChatConnector, from: string, to: string) {
  const { store } = connector;
  const extension = sdk.extensionId;
  invalidateWindows(sdk, connector, from);
  invalidateWindows(sdk, connector, to);
  sdk.database.query(`INSERT OR IGNORE INTO ${store.messages}
    SELECT extension_id,?,message_id,sent_at,content_hash,size,payload FROM ${store.messages}
    WHERE extension_id=? AND conversation_id=?`).run(to, extension, from);
  for (const table of [store.messages, store.windows, store.conversations])
    sdk.database.query(`DELETE FROM ${table} WHERE extension_id=? AND conversation_id=?`).run(extension, from);
  sdk.database.query(`UPDATE ${store.conversations} SET dirty=1,scan_from=0 WHERE extension_id=? AND conversation_id=?`)
    .run(extension, to);
  sdk.state.set(redirectKey(from), to);
}

/** RFC Message-ID dedupes folders/exports; References and In-Reply-To connect replies, regardless of import order. */
export function ingestEmail(sdk: ShaleSDK, connector: ChatConnector, record: EmailRecord): number {
  const { message } = record;
  if (!message?.messageId || !message.authorId || !Number.isSafeInteger(message.sentAt)
    || typeof message.text !== "string" || !Array.isArray(message.attachments) || !Array.isArray(record.references))
    throw new Error("Email reader returned an invalid message.");
  return sdk.database.transaction(() => {
    const ids = [...new Set([...record.references, ...(message.replyToId ? [message.replyToId] : []), message.messageId])];
    const known = [...new Set(ids.map(id => sdk.state.get(aliasKey(id))).filter((id): id is string => !!id)
      .map(id => resolveThread(sdk, id)))];
    const conversationId = known[0] ?? chatHash(ids[0]);
    const previous = connector.store.conversation(conversationId);
    connector.store.upsertConversation(previous ?? { conversationId, title: record.subject || "(No subject)", kind: "thread",
      uri: `email://inbox/thread/${conversationId}` });
    for (const from of known.slice(1)) mergeThread(sdk, connector, from, conversationId);
    for (const id of ids) sdk.state.set(aliasKey(id), conversationId);
    const latest = connector.store.latestSentAt(conversationId);
    const changed = connector.store.upsertMessages(conversationId, [message]);
    if (changed && latest !== null && message.sentAt <= latest) invalidateWindows(sdk, connector, conversationId);
    return changed;
  })();
}
