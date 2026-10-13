import type { ShaleSDK } from "@shale/sdk";
import type { ChatConnector } from "@shale/sdk/chat/commit";
import { DiscordAPI, DiscordAPIError, DiscordBudgetExceeded } from "./api";
import { parseAPIMessage } from "./parse-api";
import { discordIdentity } from "./identity";
import type { DiscordSettings } from "./settings.types";
import type { DiscordRelevanceStore } from "./relevance-store";
import { fetchReferencedContext } from "./reference-context";

/** Durable context jobs share the same network budget as normal collection. */
export async function backfillDiscord(api: DiscordAPI, sdk: ShaleSDK, connector: ChatConnector,
  settings: DiscordSettings, state: DiscordRelevanceStore, tokenUserId: string) {
  let backfilled=0;
  for (const job of state.jobs()) {
    const conversation=connector.store.conversation(job.conversation_id);
    if (!conversation) continue;
    try {
      let completeReferences=true;
      const max=settings.backfillMaxMessages ?? 1000;
      const remaining=max-job.fetched;
      const beforeMessages=api.remainingMessages;
      if (remaining<=0) {state.jobProgress(job,job.cursor,job.fetched,true);continue;}
      const self=discordIdentity(sdk,settings);
      // A thread's starter is useful context even when it lies outside the rolling archive.
      if (conversation.kind==='thread' && !job.cursor) {
        try {
          const starter=await api.get<any>(`channels/${job.conversation_id}/messages/${job.conversation_id}`);
          const parsed=parseAPIMessage(starter,self,tokenUserId);
          if (parsed && api.remainingMessages>0) {
            api.consumeMessages([parsed]);
            connector.policy?.ingest?.(conversation,[parsed]) ?? connector.store.ingest(conversation,[parsed]);
            state.observe(conversation,[parsed],self);
            completeReferences=await fetchReferencedContext(api,sdk,connector,settings,state,conversation,[parsed],tokenUserId,
              Math.max(0,remaining-(beforeMessages-api.remainingMessages)));
          }
        } catch(error) {
          if (!(error instanceof DiscordAPIError) || error.status!==404)throw error;
          completeReferences=false;
        }
      }
      const pageCapacity=remaining-(beforeMessages-api.remainingMessages);
      if(pageCapacity<=0) {
        state.jobProgress(job,job.cursor,max,true);
        state.coverage(job.conversation_id,'sampled','Backfill limit reached while retrieving starter context');
        continue;
      }
      const pageLimit=Math.min(100,pageCapacity,api.remainingMessages);
      const raw=await api.messages(job.conversation_id,{limit:pageLimit,
        ...(job.cursor ? {before:job.cursor} : job.anchor_id ? {around:job.anchor_id} : {})});
      const messages=raw.map(message=>parseAPIMessage(message,self,tokenUserId)).filter(message=>message!==null);
      const changed=(connector.policy?.ingest?.(conversation,messages) ?? connector.store.ingest(conversation,messages)).changed;
      backfilled+=changed;
      state.observe(conversation,messages,self);
      completeReferences=(await fetchReferencedContext(api,sdk,connector,settings,state,conversation,messages,tokenUserId,
        Math.max(0,remaining-(beforeMessages-api.remainingMessages)))) && completeReferences;
      const cursor=messages.reduce<string|null>((id,message)=>!id || BigInt(message.messageId)<BigInt(id) ? message.messageId : id,job.cursor);
      const fetched=job.fetched+(beforeMessages-api.remainingMessages);
      if (!messages.every(message=>connector.store.loadMessages(job.conversation_id,[message.messageId]).length)) {
        state.jobProgress(job,job.cursor,job.fetched,false,Date.now()+60_000);
        state.coverage(job.conversation_id,'incomplete','Archive capacity deferred contextual backfill');
        continue;
      }
      // Channels need their local conversation context; joined threads can page farther back.
      const truncated=pageLimit<Math.min(100,pageCapacity) && raw.length===pageLimit;
      const done=!truncated && conversation.kind!=='thread' || raw.length<pageLimit || fetched>=max;
      state.jobProgress(job,truncated && conversation.kind!=='thread' ? null : cursor,fetched,done);
      state.coverage(job.conversation_id,!completeReferences ? 'incomplete' : done && raw.length<pageLimit && conversation.kind==='thread' ? 'complete' : 'sampled',
        `Context backfill retained ${fetched} messages${fetched>=max ? '; backfill limit reached' : ''}`);
      if (changed) connector.store.invalidate(job.conversation_id);
    } catch(error) {
      if (error instanceof DiscordBudgetExceeded) break;
      const retryAt=error instanceof DiscordAPIError ? error.retryAt ?? Date.now()+60_000 : Date.now()+60_000;
      state.jobProgress(job,job.cursor,job.fetched,false,retryAt);
      state.coverage(job.conversation_id,'incomplete',`Context backfill: ${String(error)}`);
      if (error instanceof DiscordAPIError && error.status===429) throw error;
    }
  }
  return backfilled;
}
