import type { ShaleSDK } from "@shale/sdk";
import type { ChatStore } from "@shale/sdk/chat/store";
import { DiscordAPI, DiscordAPIError } from "./api";
import { discordToken } from "./auth";
import { discordIdentity } from "./identity";
import { parseAPIMessage } from "./parse-api";
import { admitDiscordMessages } from "./intake";
import type { DiscordRelevanceStore } from "./relevance-store";
import type { DiscordSettings } from "./settings.types";

/** Refresh retrieves exact missing membership, never silently summarizes an incomplete transcript. */
export async function restoreDiscordWindow(sdk: ShaleSDK, store: ChatStore, state: DiscordRelevanceStore,
  settings: DiscordSettings, windowId: string) {
  const row=store.db.query<{conversation_id:string;message_ids:string|null},[string,string]>(
    `SELECT conversation_id,message_ids FROM ${store.windows} WHERE extension_id=? AND window_id=?`).get(store.extensionId,windowId);
  if (!row?.message_ids) return;
  const conversation=store.conversation(row.conversation_id);
  const token=discordToken(sdk);
  if (!conversation || !token) return;
  const ids:string[]=JSON.parse(row.message_ids),stored=new Set(store.loadMessages(row.conversation_id,ids).map(message=>message.messageId));
  const api=new DiscordAPI(token,sdk.credentials.get('kind')==='bot' ? 'bot' : 'user',{
    requests:settings.syncMaxRequests ?? 100,messages:settings.syncMaxMessages ?? 5000,
    deadline:Date.now()+(settings.syncBudgetMinutes ?? 10)*60_000});
  for (const id of ids.filter(id=>!stored.has(id))) {
    if (api.remainingMessages<=0) break;
    try {
      const raw=await api.get<any>(`channels/${row.conversation_id}/messages/${id}`);
      const parsed=parseAPIMessage(raw,discordIdentity(sdk,settings),sdk.credentials.get('userId'));
      if (parsed) {api.consumeMessages([parsed]);admitDiscordMessages(store,state,settings,conversation,[parsed]);}
    } catch(error) {
      state.coverage(row.conversation_id,'incomplete',`Refresh could not retrieve message ${id}`);
      if (!(error instanceof DiscordAPIError) || error.status!==404) break;
    }
  }
}
