import type { ShaleSDK } from "@shale/sdk";
import type { ChatConnector } from "@shale/sdk/chat/commit";
import { discordToken } from "./auth";
import { DiscordAPI, DiscordAPIError, DiscordBudgetExceeded } from "./api";
import { discordIdentity } from "./identity";
import { parseAPIMessage } from "./parse-api";
import { discoverDiscord, scheduledConversations, isPersonalConversation, type Guild } from "./discover";
import { searchDiscordActivity } from "./activity-search";
import { backfillDiscord } from "./backfill";
import { DiscordRelevanceStore } from "./relevance-store";
import type { DiscordRelevancePolicy } from "./relevance";
import type { DiscordSettings } from "./settings.types";
import { chatHash } from "@shale/sdk/chat/hash";

/** One bounded sweep. Both normal reads and contextual backfill spend the same budget. */
export async function syncDiscordREST(sdk: ShaleSDK, connector: ChatConnector, settings: DiscordSettings,
  deadline: number, afterChannel: () => Promise<void>) {
  const result={channels:0,skipped:0,messages:0,errors:[] as string[],backfilled:0,incomplete:0};
  const token=discordToken(sdk);
  if (!token) {sdk.logger.warn("Discord sync skipped: connect an account on the Accounts page.");return result;}
  const kind=sdk.credentials.get("kind")==='bot' ? 'bot' : 'user';
  const api=new DiscordAPI(token,kind,{requests:settings.syncMaxRequests ?? 100,messages:settings.syncMaxMessages ?? 5000,deadline});
  const policy=connector.policy as DiscordRelevancePolicy | undefined;
  const state=policy?.state ?? new DiscordRelevanceStore(sdk,connector.store);
  let tokenUserId=sdk.credentials.get("userId") ?? '';
  const retry=Number(sdk.state.get("rest:retry") ?? 0);
  if (retry>Date.now()) {result.incomplete++;return result;}
  try {
    const identity=sdk.state.getJson<{id:string;kind:string;tokenHash:string}>("identity");
    if (!tokenUserId && identity?.tokenHash!==chatHash(token)) {
      const user=await api.get<{id:string}>("users/@me");tokenUserId=user.id;
      sdk.state.setJson("identity",{id:user.id,kind,tokenHash:chatHash(token)});
    } else if (!tokenUserId) tokenUserId=identity!.id;
    let guilds=sdk.state.getJson<Guild[]>("rest:guilds") ?? [];
    if ((settings.syncScope ?? 'all')==='selected') guilds=guilds.filter(guild=>(settings.guilds ?? []).includes(guild.id)
      || (settings.channels ?? []).some(id=>connector.store.conversation(id)?.server?.id===guild.id));
    try {guilds=await discoverDiscord(api,sdk,connector,settings,state);}
    catch(error) {
      if (error instanceof DiscordBudgetExceeded || error instanceof DiscordAPIError && [401,429].includes(error.status)) throw error;
      result.errors.push(`Discovery incomplete: ${String(error)}`);result.incomplete++;
    }
    await policy?.start();
    await searchDiscordActivity(api,sdk,connector,settings,state,guilds,tokenUserId);
    const self=discordIdentity(sdk,settings);
    const conversations=scheduledConversations(connector,settings,state);
    // Keep capacity for low-priority exploration even when personal conversations are numerous.
    const personal=conversations.filter(conversation=>isPersonalConversation(conversation,settings,state));
    const exploration=conversations.filter(conversation=>!personal.includes(conversation));
    const rotate=(list:typeof conversations,key:string)=>{
      const position=Number(sdk.state.get(key) ?? 0)%Math.max(1,list.length);
      return [...list.slice(position),...list.slice(0,position)];
    };
    const capacity=Math.max(1,Math.floor((api.remainingRequests-20)/2));
    const selectedPersonal=rotate(personal,'rest:personal:position').slice(0,Math.max(1,Math.ceil(capacity*.8)));
    const selectedExploration=rotate(exploration,'rest:exploration:position').slice(0,Math.max(1,capacity-selectedPersonal.length));
    const ordered=[...selectedPersonal,...selectedExploration];
    for (const conversation of ordered) {
      const key=`rest:channel:${conversation.conversationId}`;
      if (Number(sdk.state.get(`${key}:retry`) ?? 0)>Date.now()) {result.skipped++;continue;}
      try {
        const cursor=sdk.state.get(key);
        // Re-read the newest page to notice reactions and edits; a separate cursor covers backlog.
        const raw=await api.messages(conversation.conversationId,{limit:100});
        const messages=raw.map(message=>parseAPIMessage(message,self,tokenUserId)).filter(message=>message!==null);
        const imported=connector.policy?.ingest?.(conversation,messages) ?? connector.store.ingest(conversation,messages);
        state.observe(conversation,messages,self);
        result.messages+=imported.changed;result.channels++;
        const newest=messages.reduce<string|null>((id,message)=>!id || BigInt(message.messageId)>BigInt(id) ? message.messageId : id,null);
        if (!cursor) {
          if(newest)sdk.state.set(key,newest);
          state.coverage(conversation.conversationId,'sampled',"Initial newest-message sample; older context is fetched on personal activity");
        } else if (newest && BigInt(newest)>BigInt(cursor)) {
          const page=await api.messages(conversation.conversationId,{after:cursor,limit:100});
          const changed=page.map(message=>parseAPIMessage(message,self,tokenUserId)).filter(message=>message!==null);
          const admitted=connector.policy?.ingest?.(conversation,changed) ?? connector.store.ingest(conversation,changed);
          state.observe(conversation,changed,self);result.messages+=admitted.changed;
          const max=changed.reduce((id,message)=>BigInt(message.messageId)>BigInt(id) ? message.messageId : id,cursor);
          // Cursor advances only through ingested pages; capped backlog continues next sweep.
          const retained=changed.every(message=>connector.store.loadMessages(conversation.conversationId,[message.messageId]).length);
          if (retained) sdk.state.set(key,max);
          const complete=retained && page.length<100;
          state.coverage(conversation.conversationId,complete ? 'complete' : 'incomplete',
            !retained ? 'Archive capacity deferred incremental activity'
              : complete ? 'Incremental interval complete; original history remains sampled' : 'Incremental backlog remains');
        }
        sdk.state.delete(`${key}:retry`);
        const tier=personal.includes(conversation) ? personal : exploration;
        sdk.state.set(personal.includes(conversation) ? 'rest:personal:position' : 'rest:exploration:position',
          String((tier.indexOf(conversation)+1)%Math.max(1,tier.length)));
        await afterChannel();
      } catch(error) {
        if (error instanceof DiscordBudgetExceeded) throw error;
        if (error instanceof DiscordAPIError) {
          sdk.state.set(`${key}:retry`,String(error.retryAt ?? Date.now()+(error.status===403 ? 7*86_400_000 : 60_000)));
          if (error.status===403)result.skipped++;else result.errors.push(`${conversation.title}: ${error.message}`);
          state.coverage(conversation.conversationId,'incomplete',error.message);result.incomplete++;
          if ([401,429].includes(error.status))throw error;
        } else {result.errors.push(`${conversation.title}: ${String(error)}`);result.incomplete++;}
      }
      // Context jobs get network capacity before the rest of a large server's exploration sweep.
      if (api.remainingRequests<=20 || api.remainingMessages<=1000) break;
    }
    result.backfilled=await backfillDiscord(api,sdk,connector,settings,state,tokenUserId);
  } catch(error) {
    if (error instanceof DiscordAPIError && error.retryAt) sdk.state.set("rest:retry",String(error.retryAt));
    result.incomplete++;
    if (!(error instanceof DiscordBudgetExceeded)) result.errors.push(String(error));
  }
  result.incomplete=Math.max(result.incomplete,sdk.database.query<{n:number},[string]>(
    "SELECT count(*) AS n FROM discord_coverage WHERE extension_id=? AND mode='incomplete'").get(sdk.extensionId)!.n);
  return result;
}
