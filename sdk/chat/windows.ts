import { chatHash, type ChatStore } from "./store";
import type { ChatWindow, ChatWindowSettings } from "./types";
import { conversationHash } from "./conversation-hash";

export const CHAT_WINDOW_DEFAULTS = Object.freeze({
  gapMinutes: 30, maxWindowMessages: 120, maxWindowChars: 11000, idleMinutes: 60, maxAttempts: 5, maxWindowsPerRun: 50,
});

type Item = [id: string, sentAt: number, hash: string, size: number];

/**
 * Split changed conversations into sealed windows. A silence longer than `gapMinutes`
 * starts a new window, and long bursts are cut by message count and transcript size.
 * A window id derives from its first message, so a window that grows keeps its source.
 * Scans resume from the earliest window that may still change (`scan_from`).
 */
export function pendingWindows(store: ChatStore, platform: string, settings: ChatWindowSettings, now = Date.now()): ChatWindow[] {
  const gap = (settings.gapMinutes ?? CHAT_WINDOW_DEFAULTS.gapMinutes) * 60000;
  const idle = (settings.idleMinutes ?? CHAT_WINDOW_DEFAULTS.idleMinutes) * 60000;
  const maxMessages = Math.max(1, settings.maxWindowMessages ?? CHAT_WINDOW_DEFAULTS.maxWindowMessages);
  const maxChars = Math.max(500, settings.maxWindowChars ?? CHAT_WINDOW_DEFAULTS.maxWindowChars);
  const maxAttempts = settings.maxAttempts ?? CHAT_WINDOW_DEFAULTS.maxAttempts;
  const limit = settings.maxWindowsPerRun ?? CHAT_WINDOW_DEFAULTS.maxWindowsPerRun;
  const windows: ChatWindow[] = [];
  for (const conversationId of store.dirtyConversations()) {
    if (windows.length >= limit) break;
    const conversation = store.conversation(conversationId);
    if (!conversation) continue;
    const scanFrom = store.scanFrom(conversationId);
    const groups = store.db.query<{ items: string }, [string, string, number, number]>(`
      WITH ordered AS (
        SELECT message_id,sent_at,content_hash,size,lag(sent_at) OVER w AS previous_at
        FROM ${store.messages} WHERE extension_id=? AND conversation_id=? AND sent_at>=?
        WINDOW w AS (ORDER BY sent_at,message_id)
      ), grouped AS (
        SELECT *,sum(CASE WHEN previous_at IS NULL OR sent_at-previous_at>? THEN 1 ELSE 0 END)
          OVER (ORDER BY sent_at,message_id) AS group_id FROM ordered
      )
      SELECT json_group_array(json_array(message_id,sent_at,content_hash,size) ORDER BY sent_at,message_id) AS items
      FROM grouped GROUP BY group_id ORDER BY group_id`,
    ).all(store.extensionId, conversationId, scanFrom, gap);
    const segments: Item[][] = [];
    for (const group of groups) {
      let current: Item[] = [], chars = 0;
      segments.push(current);
      for (const item of JSON.parse(group.items) as Item[]) {
        if (current.length && (current.length >= maxMessages || chars + item[3] > maxChars)) {
          segments.push(current = []);
          chars = 0;
        }
        current.push(item);
        chars += item[3];
      }
    }
    // The earliest segment that is not yet settled is where the next scan resumes.
    let resumeFrom: number | undefined, retryLater = false;
    for (const [index, segment] of segments.entries()) {
      const startTime = segment[0]![1], endTime = segment[segment.length - 1]![1];
      if (index === segments.length - 1 && endTime >= now - idle) {
        resumeFrom ??= startTime;
        continue;
      }
      const windowId = chatHash([platform, conversationId, segment[0]![0]]);
      const messageHash = chatHash([conversationHash(conversation), segment.map(([id, , hash]) => [id, hash])]);
      const state = store.windowState(windowId);
      if (state?.indexed_hash === messageHash) continue;
      if (state?.message_hash === messageHash && state.attempts >= maxAttempts) continue;
      resumeFrom ??= startTime;
      if (state?.message_hash === messageHash && state.next_attempt_at > now) { retryLater = true; continue; }
      if (windows.length >= limit) { retryLater = true; continue; }
      store.recordWindow(windowId, conversationId, startTime, endTime, messageHash,segment.map(([id])=>id));
      windows.push({ windowId, conversation, startTime, endTime, messageHash,
        messages: store.loadMessages(conversationId, segment.map(([id]) => id)) });
    }
    const last = segments[segments.length - 1];
    // Indexed windows are kept dirty until they commit; a failed commit is then retried.
    const dirty = resumeFrom !== undefined || retryLater;
    store.finishScan(conversationId, scanFrom, resumeFrom ?? last?.[0]?.[1] ?? scanFrom, dirty);
  }
  return windows;
}
