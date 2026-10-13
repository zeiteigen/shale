import type { ChatConversation, ChatMessage } from "@shale/sdk/chat/types";
import type { ChatStore } from "@shale/sdk/chat/store";
import type { DiscordSettings } from "./settings.types";
import type { DiscordRelevanceStore } from "./relevance-store";
import { rawArchiveStats } from "./archive";

/** Backpressure protects an archive pinned by classification or recovery; signals still get recorded. */
export function admitDiscordMessages(store: ChatStore, state: DiscordRelevanceStore,
  settings: DiscordSettings, conversation: ChatConversation, messages: ChatMessage[]) {
  let bytes=rawArchiveStats(store).bytes;
  let count=store.db.query<{n:number},[string,string]>(`SELECT count(*) AS n FROM ${store.messages}
    WHERE extension_id=? AND conversation_id=?`).get(store.extensionId,conversation.conversationId)!.n;
  const maxBytes=(settings.rawMaxMiB ?? 256)*1024*1024,maxCount=settings.rawMaxConversationMessages ?? 5000;
  const admitted:ChatMessage[]=[];
  // Newest context gets the first chance at remaining space, independent of server volume.
  for (const message of [...messages].sort((a,b)=>b.sentAt-a.sentAt)) {
    const previous=store.db.query<{bytes:number},[string,string,string]>(
      `SELECT length(cast(payload AS BLOB)) AS bytes FROM ${store.messages} WHERE extension_id=? AND conversation_id=? AND message_id=?`)
      .get(store.extensionId,conversation.conversationId,message.messageId);
    const delta=Buffer.byteLength(JSON.stringify(message))-(previous?.bytes ?? 0);
    if (bytes+delta>maxBytes || !previous && count>=maxCount) continue;
    admitted.push(message);bytes+=delta;if(!previous)count++;
  }
  if (admitted.length<messages.length) state.coverage(conversation.conversationId,"incomplete",
    `Archive budget admitted ${admitted.length}/${messages.length} messages; missing context can be fetched by promotion jobs`);
  return store.ingest(conversation,admitted);
}
