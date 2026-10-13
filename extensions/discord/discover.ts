import type { ShaleSDK } from "@shale/sdk";
import type { ChatConnector } from "@shale/sdk/chat/commit";
import type { ChatConversation } from "@shale/sdk/chat/types";
import { DiscordAPIError, type DiscordAPI } from "./api";
import { parseAPIConversation } from "./parse-api";
import type { DiscordSettings } from "./settings.types";
import type { DiscordRelevanceStore } from "./relevance-store";

export interface Guild {id:string;name:string}
const readable=(channel:any)=>[0,1,3,5,10,11,12].includes(Number(channel.type));

export function saveChannel(connector: ChatConnector, raw: any, guild?: Guild) {
  if (!raw?.id || !readable(raw)) return null;
  const conversation=parseAPIConversation(raw,guild);
  connector.store.upsertConversation(conversation);
  return conversation;
}

/** Metadata discovery rotates guilds; threads are independently scheduled instead of recursive exports. */
export async function discoverDiscord(api: DiscordAPI, sdk: ShaleSDK, connector: ChatConnector,
  settings: DiscordSettings, state: DiscordRelevanceStore): Promise<Guild[]> {
  const read=async<T>(path:string,query?:Record<string,string|number>):Promise<T|null>=>{
    const key=`rest:metadata:${path}:retry`;
    if(Number(sdk.state.get(key) ?? 0)>Date.now())return null;
    try {const result=await api.get<T>(path,query);sdk.state.delete(key);return result;}
    catch(error) {
      if(!(error instanceof DiscordAPIError) || [401,429].includes(error.status))throw error;
      sdk.state.set(key,String(error.retryAt ?? Date.now()+([403,404].includes(error.status) ? 7*86_400_000 : 60_000)));
      state.coverage(path,'incomplete',`Metadata discovery: ${error.message}`);
      return null;
    }
  };
  const all=(settings.syncScope ?? 'all')==='all';
  let guilds=sdk.state.getJson<Guild[]>("rest:guilds") ?? [];
  if (all) {
    const after=sdk.state.get("rest:guilds:cursor");
    const page=await read<Guild[]>("users/@me/guilds",{limit:200,...(after ? {after} : {})});
    if(page) {
      if (!Array.isArray(page)) throw new Error("Discord returned invalid guild metadata");
      if (!after) guilds=[];
      guilds=[...new Map([...guilds,...page].map(guild=>[guild.id,guild])).values()];
      sdk.state.setJson("rest:guilds",guilds);
      page.length===200 ? sdk.state.set("rest:guilds:cursor",page.at(-1)!.id) : sdk.state.delete("rest:guilds:cursor");
    }
  }
  for (const id of settings.guilds ?? []) if (!guilds.some(guild=>guild.id===id)) {
    const guild=await read<Guild>(`guilds/${id}`);if(guild)guilds.push(guild);
  }
  if (!all) guilds=guilds.filter(guild=>(settings.guilds ?? []).includes(guild.id));
  const start=Number(sdk.state.get("rest:discovery:position") ?? 0)%Math.max(1,guilds.length);
  const rotated=[...guilds.slice(start),...guilds.slice(0,start)];
  const visited=new Set<string>();
  for (const guild of rotated.slice(0,10)) {
    visited.add(guild.id);
    const channels=await read<any[]>(`guilds/${guild.id}/channels`);
    if(!channels)continue;
    for (const channel of channels) saveChannel(connector,channel,guild);
    if (settings.includeThreads!=='none') {
      const active=await read<{threads:any[];members:Array<{id:string;join_timestamp?:string}>}>(`guilds/${guild.id}/threads/active`);
      for (const thread of active?.threads ?? []) saveChannel(connector,thread,guild);
      if (sdk.credentials.get('kind')!=='bot')
        for (const member of active?.members ?? []) state.promote(member.id,"joined",Date.parse(member.join_timestamp ?? '') || Date.now(),"","joined");
      if (settings.includeThreads==='all') {
        // Enumerate one parent's archived metadata per guild per sweep, never every forum recursively.
        const parents=channels.filter(channel=>[0,5,15,16].includes(Number(channel.type)));
        const position=Number(sdk.state.get(`rest:archives:${guild.id}:position`) ?? 0)%Math.max(1,parents.length);
        const parent=parents[position];
        if (parent) {
          const key=`rest:archives:${parent.id}:before`,before=sdk.state.get(key);
          const archived=await read<{threads:any[];members:Array<{id:string;join_timestamp?:string}>;has_more:boolean}>(
            `channels/${parent.id}/threads/archived/public`,{limit:50,...(before ? {before} : {})});
          for (const thread of archived?.threads ?? []) saveChannel(connector,thread,guild);
          if (sdk.credentials.get('kind')!=='bot')
            for (const member of archived?.members ?? []) state.promote(member.id,"joined",Date.parse(member.join_timestamp ?? '') || Date.now(),"","joined");
          if (archived?.has_more && archived.threads.length) sdk.state.set(key,archived.threads.at(-1)!.thread_metadata.archive_timestamp);
          else if(archived) {sdk.state.delete(key);sdk.state.set(`rest:archives:${guild.id}:position`,String(position+1));}
          if(sdk.credentials.get('kind')!=='bot') {
            const privateKey=`rest:archives:${parent.id}:private`,privateBefore=sdk.state.get(privateKey);
            const joined=await read<{threads:any[];members:Array<{id:string;join_timestamp?:string}>;has_more:boolean}>(
              `channels/${parent.id}/users/@me/threads/archived/private`,{limit:50,...(privateBefore ? {before:privateBefore} : {})});
            for(const thread of joined?.threads ?? []) {
              saveChannel(connector,thread,guild);state.promote(thread.id,'joined',Date.now(),'','joined');
            }
            if(joined?.has_more && joined.threads.length)sdk.state.set(privateKey,joined.threads.at(-1)!.id);
            else if(joined)sdk.state.delete(privateKey);
          }
        }
      }
    }
    sdk.state.set("rest:discovery:position",String((guilds.indexOf(guild)+1)%Math.max(1,guilds.length)));
  }
  for (const id of settings.channels ?? []) {
    const channel=await read<any>(`channels/${id}`);
    if(!channel)continue;
    const guild=channel.guild_id ? guilds.find(guild=>guild.id===channel.guild_id)
      ?? await read<Guild>(`guilds/${channel.guild_id}`) : undefined;
    saveChannel(connector,channel,guild ?? undefined);
    if(guild && !guilds.some(item=>item.id===guild.id))guilds.push(guild);
    if (guild && !visited.has(guild.id) && settings.includeThreads!=='none') {
      visited.add(guild.id);
      const active=await read<{threads:any[];members:Array<{id:string;join_timestamp?:string}>}>(`guilds/${guild.id}/threads/active`);
      for (const thread of active?.threads ?? []) saveChannel(connector,thread,guild);
      if (sdk.credentials.get('kind')!=='bot') for (const member of active?.members ?? [])
        if (active?.threads.some(thread=>thread.id===member.id && (thread.parent_id===id || thread.id===id)))
          state.promote(member.id,'joined',Date.parse(member.join_timestamp ?? '') || Date.now(),'','joined');
    }
  }
  if ((all || settings.includeDMs) && sdk.credentials.get("kind")!=='bot') {
    const dms=await read<any[]>("users/@me/channels");
    for (const dm of dms ?? []) saveChannel(connector,{...dm,name:dm.name || dm.recipients?.map((user:any)=>user.global_name || user.username).join(', ')});
  }
  return guilds;
}

/** Round robin across servers within each priority tier. */
export function scheduledConversations(connector: ChatConnector, settings: DiscordSettings, state: DiscordRelevanceStore): ChatConversation[] {
  const all=(settings.syncScope ?? 'all')==='all';
  const rows=connector.store.db.query<{payload:string},[string]>(
    `SELECT payload FROM ${connector.store.conversations} WHERE extension_id=? ORDER BY conversation_id`).all(connector.store.extensionId);
  const eligible=rows.map(row=>JSON.parse(row.payload) as ChatConversation).filter(conversation=>
    !(settings.excludedConversations ?? []).includes(conversation.conversationId)
    && (settings.includeThreads!=='none' || conversation.kind!=='thread')
    && (all || (settings.channels ?? []).includes(conversation.conversationId)
      || !!conversation.parentId && (settings.channels ?? []).includes(conversation.parentId)
      || !!conversation.server && (settings.guilds ?? []).includes(conversation.server.id)
      || !!settings.includeDMs && ['dm','group'].includes(conversation.kind)));
  const personal=eligible.filter(conversation=>isPersonalConversation(conversation,settings,state));
  const other=eligible.filter(conversation=>!personal.includes(conversation));
  const interleave=(conversations:ChatConversation[])=>{
    const groups=new Map<string,ChatConversation[]>();
    for (const conversation of conversations) {
      const id=conversation.server?.id ?? 'dm',group=groups.get(id) ?? [];
      group.push(conversation);groups.set(id,group);
    }
    const result:ChatConversation[]=[];
    while ([...groups.values()].some(group=>group.length)) for (const group of groups.values()) {const item=group.shift();if(item)result.push(item);}
    return result;
  };
  return [...interleave(personal),...interleave(other)];
}

export function isPersonalConversation(conversation: ChatConversation,settings: DiscordSettings,state: DiscordRelevanceStore) {
  return ['dm','group'].includes(conversation.kind) || state.joined(conversation.conversationId)
    || state.signalFingerprint(conversation.conversationId)!==state.signalFingerprint('__none__')
    || (settings.includedConversations ?? []).includes(conversation.conversationId);
}
