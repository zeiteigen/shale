import type { ShaleSDK } from "@shale/sdk";
import type { ChatConnector } from "@shale/sdk/chat/commit";
import type { ChatConversation,ChatMessage } from "@shale/sdk/chat/types";
import { DiscordAPI,DiscordAPIError } from "./api";
import { parseAPIMessage } from "./parse-api";
import { saveChannel } from "./discover";
import { discordIdentity } from "./identity";
import type { DiscordSettings } from "./settings.types";
import type { DiscordRelevanceStore } from "./relevance-store";

/** One-hop references can recover an old reply target or a thread's original parent message. */
export async function fetchReferencedContext(api: DiscordAPI,sdk: ShaleSDK,connector: ChatConnector,
  settings: DiscordSettings,state: DiscordRelevanceStore,conversation: ChatConversation,messages: ChatMessage[],tokenUserId: string,maxNewMessages=20) {
  const allReferences=[...new Map(messages.filter(message=>message.replyToId)
    .map(message=>[`${message.replyConversationId ?? conversation.conversationId}:${message.replyToId}`,message])).values()];
  const references=allReferences.slice(0,20);
  let complete=references.length===allReferences.length;
  let fetched=0;
  for (const message of references) {
    const channel=message.replyConversationId ?? conversation.conversationId,id=message.replyToId!;
    if((settings.excludedConversations ?? []).includes(channel))continue;
    let target=connector.store.conversation(channel);
    const existing=connector.store.loadMessages(channel,[id])[0];
    if (existing && target) {state.promote(channel,id,existing.sentAt,existing.authorId,'referenced');continue;}
    if(fetched>=maxNewMessages || api.remainingMessages<=0) {complete=false;continue;}
    try {
      if (!target) target=saveChannel(connector,await api.get<any>(`channels/${channel}`),conversation.server);
      const raw=await api.get<any>(`channels/${channel}/messages/${id}`);
      const parsed=parseAPIMessage(raw,discordIdentity(sdk,settings),tokenUserId);
      if (!target || !parsed || api.remainingMessages<=0) {complete=false;continue;}
      api.consumeMessages([parsed]);
      fetched++;
      connector.policy?.ingest?.(target,[parsed]) ?? connector.store.ingest(target,[parsed]);
      state.promote(channel,id,parsed.sentAt,parsed.authorId,'referenced');
      if (!connector.store.loadMessages(channel,[id]).length) complete=false;
    } catch(error) {
      state.coverage(conversation.conversationId,'incomplete',`Referenced message ${id} is unavailable`);
      complete=false;
      if (!(error instanceof DiscordAPIError) || ![403,404].includes(error.status))throw error;
    }
  }
  return complete;
}
