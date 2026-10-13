import type { ShaleSDK } from "@shale/sdk";
import type { ChatConnector } from "@shale/sdk/chat/commit";
import { DiscordAPI, DiscordAPIError } from "./api";
import { discordIdentity } from "./identity";
import { parseAPIMessage } from "./parse-api";
import { saveChannel, type Guild } from "./discover";
import type { DiscordSettings } from "./settings.types";
import type { DiscordRelevanceStore } from "./relevance-store";

export const discordSnowflake=(time:number)=>((BigInt(Math.max(0,Math.floor(time)-1420070400000)))<<22n).toString();

/** Search personal signals without paging through every unrelated message in a public server. */
export async function searchDiscordActivity(api: DiscordAPI, sdk: ShaleSDK, connector: ChatConnector,
  settings: DiscordSettings, state: DiscordRelevanceStore, guilds: Guild[], tokenUserId: string) {
  const self=discordIdentity(sdk,settings);
  if (!self.length || !guilds.length) return;
  const start=Number(sdk.state.get("rest:activity:position") ?? 0)%guilds.length;
  for (const guild of [...guilds.slice(start),...guilds.slice(0,start)].slice(0,10)) {
    for (const mode of ['author_id','mentions','replied_to_user_id']) {
      if (api.remainingMessages<=0) return;
      const key=`rest:activity:${guild.id}:${mode}`,retry=Number(sdk.state.get(`${key}:retry`) ?? 0);
      if (retry>Date.now()) continue;
      const after=sdk.state.get(key) ?? discordSnowflake(Date.now()-(settings.rawRetentionDays ?? 30)*86_400_000);
      try {
        const allowed=(settings.syncScope ?? 'all')==='selected' && !(settings.guilds ?? []).includes(guild.id)
          ? connector.store.db.query<{payload:string},[string]>(`SELECT payload FROM ${connector.store.conversations} WHERE extension_id=?`)
            .all(connector.store.extensionId).map(row=>JSON.parse(row.payload))
            .filter(conversation=>conversation.server?.id===guild.id && ((settings.channels ?? []).includes(conversation.conversationId)
              || (settings.channels ?? []).includes(conversation.parentId))).map(conversation=>conversation.conversationId).slice(0,500)
          : undefined;
        if (allowed && !allowed.length)continue;
        const response=await api.get<{messages:any[][];threads?:any[]}>(`guilds/${guild.id}/messages/search`,
          {[mode]:self,min_id:after,limit:Math.min(25,api.remainingMessages),sort_by:'timestamp',sort_order:'asc',
            ...(allowed ? {channel_id:allowed} : {})});
        for (const thread of response.threads ?? []) saveChannel(connector,thread,guild);
        const raw=api.consumeMessages(response.messages.flat());
        const excluded=new Set(settings.excludedConversations ?? []);
        let newest=after;
        for (const message of raw) {
          if (excluded.has(String(message.channel_id))) {
            if (BigInt(message.id)>BigInt(newest)) newest=String(message.id);
            continue;
          }
          let conversation=connector.store.conversation(message.channel_id);
          if (!conversation) conversation=saveChannel(connector,await api.get<any>(`channels/${message.channel_id}`),guild);
          const parsed=parseAPIMessage(message,self,tokenUserId);
          if (!conversation || !parsed) continue;
          connector.policy?.ingest?.(conversation,[parsed]) ?? connector.store.ingest(conversation,[parsed]);
          state.observe(conversation,[parsed],self);
          const reason=mode==='author_id' ? 'authored' : mode==='mentions' ? 'mentioned' : 'reply';
          state.promote(conversation.conversationId,parsed.messageId,parsed.sentAt,parsed.authorId,reason);
          if (connector.store.loadMessages(conversation.conversationId,[parsed.messageId]).length && BigInt(parsed.messageId)>BigInt(newest)) newest=parsed.messageId;
        }
        // Intentional exclusions are resolved; capacity-rejected messages still hold the cursor.
        const complete=raw.every(message=>excluded.has(String(message.channel_id))
          || connector.store.loadMessages(message.channel_id,[String(message.id)]).length);
        if(complete)sdk.state.set(key,newest);
        else state.coverage(`guild:${guild.id}`,'incomplete','Archive capacity deferred personal activity pagination');
        sdk.state.delete(`${key}:retry`);
      } catch(error) {
        if (!(error instanceof DiscordAPIError)) throw error;
        const retryAt=error.retryAt ?? Date.now()+(error.status===403 ? 7*86_400_000 : 60_000);
        sdk.state.set(`${key}:retry`,String(retryAt));
        state.coverage(`guild:${guild.id}`,'incomplete',`Personal search ${mode}: ${error.message}`);
        if (error.status===429) throw error;
      }
    }
    sdk.state.set("rest:activity:position",String((guilds.indexOf(guild)+1)%guilds.length));
  }
}
