import type { ShaleSDK } from "@shale/sdk";
import { resetConversationWindows, type ChatConnector } from "@shale/sdk/chat/commit";
import type { ChatAttachment, ChatMessage } from "@shale/sdk/chat/types";
import type { AiChatMessage, AiChatSnapshot } from "./contract";
import { assistantName, conversationUri } from "./connector";
import { AI_CHATS_DEFAULTS, type AiChatsSettings } from "./settings.types";

const revisionKey = (record: AiChatSnapshot) => `revision:${record.provider}:${record.conversationId}`;

/**
 * Give every message a time that keeps the page's order. Page captures (Gemini) carry none:
 * a message seen before keeps its stored time; a new one sits just after its predecessor,
 * or at the capture time when it is the newest.
 */
export function assignTimes(messages: AiChatMessage[], stored: Map<string, number>, now = Date.now()): number[] {
  const known = messages.map(message => message.sentAt ?? stored.get(message.id));
  const times: number[] = [];
  for (let i = 0; i < known.length; i++) {
    const previous = times[i - 1];
    let time = known[i];
    if (time === undefined) {
      const next = known.findIndex((value, j) => j > i && value !== undefined);
      if (next < 0) time = Math.max(now, (previous ?? 0) + 1);
      else time = previous === undefined ? known[next]! - (next - i) : previous + 1;
    }
    times.push(previous === undefined ? time : Math.max(time, previous + 1));
  }
  return times;
}

/**
 * Apply one snapshot to the provider's message log. Raw messages are the durable record;
 * windows are cut and summarised later by the `ai-chats-index` cron.
 */
export function applySnapshot(sdk: ShaleSDK, connector: ChatConnector, settings: AiChatsSettings, record: AiChatSnapshot,
  now = Date.now()): { status: "received" | "skipped"; reason?: string; changed: number; removed: number } {
  return sdk.database.transaction(() => {
    const latest = Number(sdk.state.get(revisionKey(record)) ?? -1);
    if (record.revision < latest)
      return { status: "skipped" as const, reason: "Superseded by a newer capture of this conversation", changed: 0, removed: 0 };
    const { store } = connector;
    const conversationId = record.conversationId;
    const stored = new Map(store.loadMessages(conversationId, record.messages.map(message => message.id))
      .map(message => [message.messageId, message.sentAt]));
    const times = assignTimes(record.messages, stored, now);
    const userName = settings.userName?.trim() || AI_CHATS_DEFAULTS.userName;
    const messages: ChatMessage[] = record.messages.map((message, i) => ({
      messageId: message.id,
      authorId: message.role,
      authorName: message.role === "user" ? userName : assistantName(record.provider),
      sentAt: times[i]!,
      text: message.text,
      attachments: message.attachments.map(({ name, kind, url }): ChatAttachment => ({ name, kind, url })),
      isBot: message.role === "assistant" || undefined,
    }));
    const { changed } = store.ingest({
      conversationId, title: record.title || "Untitled chat", kind: "dm", uri: conversationUri(record.provider, conversationId),
    }, messages);
    // An edit or regeneration moved the conversation to another branch: drop the abandoned one.
    const removed = record.pathIds ? store.retainMessages(conversationId, record.pathIds) : 0;
    if (removed) resetConversationWindows(sdk, connector, conversationId);
    sdk.state.set(revisionKey(record), String(Math.max(latest, record.revision)));
    return { status: "received" as const, changed, removed };
  })();
}
