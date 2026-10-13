import type { ShaleSDK } from "@shale/sdk";
import type { ChatStore } from "@shale/sdk/chat/store";
import type { DiscordSettings } from "./settings.types";

export function rawArchiveStats(store: ChatStore) {
  return store.db.query<{bytes:number;messages:number},[string]>(
    `SELECT coalesce(sum(length(cast(payload AS BLOB))),0) AS bytes,count(*) AS messages
     FROM ${store.messages} WHERE extension_id=?`).get(store.extensionId)!;
}

/** Eviction removes whole settled windows, retaining source text and exact membership metadata. */
export function trimDiscordArchive(sdk: ShaleSDK, store: ChatStore, settings: DiscordSettings, now=Date.now()) {
  const cutoff=now-(settings.rawRetentionDays ?? 30)*86_400_000;
  const maxBytes=(settings.rawMaxMiB ?? 256)*1024*1024,maxMessages=settings.rawMaxConversationMessages ?? 5000;
  let bytes=rawArchiveStats(store).bytes,evicted=0;
  const counts=new Map(store.db.query<{conversation_id:string;n:number},[string]>(
    `SELECT conversation_id,count(*) AS n FROM ${store.messages} WHERE extension_id=? GROUP BY conversation_id`)
    .all(store.extensionId).map(row=>[row.conversation_id,row.n]));
  const rows=store.db.query<{window_id:string;conversation_id:string;start_time:number;end_time:number;message_ids:string},[string,number]>(
    `SELECT w.*,r.message_ids AS message_ids FROM ${store.windows} w LEFT JOIN discord_relevance r
      ON r.extension_id=w.extension_id AND r.window_id=w.window_id WHERE w.extension_id=? AND w.end_time<?
      AND NOT EXISTS(SELECT 1 FROM checkpoints c WHERE c.extension_id=w.extension_id AND c.id='chat_window:'||w.window_id)
      AND r.status IN ('accepted','excluded') AND w.indexed_hash IS NOT NULL AND r.message_hash=w.message_hash
      ORDER BY CASE WHEN r.status='excluded' THEN 0 ELSE 1 END,w.end_time,w.window_id`)
    .all(store.extensionId,now-(settings.idleMinutes ?? 60)*60_000);
  for (const row of rows) {
    if (row.end_time>=cutoff && bytes<=maxBytes && (counts.get(row.conversation_id) ?? 0)<=maxMessages) continue;
    const messages=store.db.query<{message_id:string;bytes:number},[string,string,string]>(
      `SELECT message_id,length(cast(payload AS BLOB)) AS bytes FROM ${store.messages}
       WHERE extension_id=? AND conversation_id=? AND message_id IN (SELECT value FROM json_each(?))`)
      .all(store.extensionId,row.conversation_id,row.message_ids);
    if (!messages.length) continue;
    store.db.transaction(()=>{
      store.db.query(`DELETE FROM ${store.messages} WHERE extension_id=? AND conversation_id=?
        AND message_id IN (SELECT value FROM json_each(?))`).run(store.extensionId,row.conversation_id,JSON.stringify(messages.map(message=>message.message_id)));
      store.db.query("UPDATE discord_relevance SET raw_available=0 WHERE extension_id=? AND window_id=?")
        .run(store.extensionId,row.window_id);
      // A later decided window may be evicted before an earlier pending one. Rescan retained
      // messages so neither that pending window nor a segment sharing its timestamp is skipped.
      store.db.query(`UPDATE ${store.conversations} SET scan_from=0,dirty=CASE WHEN EXISTS(
        SELECT 1 FROM ${store.messages} m WHERE m.extension_id=? AND m.conversation_id=?) THEN 1 ELSE 0 END
        WHERE extension_id=? AND conversation_id=?`)
        .run(store.extensionId,row.conversation_id,store.extensionId,row.conversation_id);
    })();
    bytes-=messages.reduce((sum,message)=>sum+message.bytes,0);
    counts.set(row.conversation_id,(counts.get(row.conversation_id) ?? 0)-messages.length);
    evicted+=messages.length;
  }
  // Durable activity is bounded too; retain one joined marker and the contact identities.
  sdk.database.query("DELETE FROM discord_activity WHERE extension_id=? AND sent_at<? AND reason!='joined'")
    .run(store.extensionId,cutoff);
  sdk.database.query("DELETE FROM discord_promotions WHERE extension_id=? AND done=1 AND created_at<?")
    .run(store.extensionId,cutoff);
  // Old negative decisions need not grow indefinitely after their raw context has expired.
  const expired=store.db.query<{window_id:string},[string,number]>(
    `SELECT w.window_id FROM ${store.windows} w JOIN discord_relevance r ON r.extension_id=w.extension_id AND r.window_id=w.window_id
      WHERE w.extension_id=? AND w.source_id IS NULL AND w.end_time<? AND r.raw_available=0
      AND r.status='excluded' AND w.indexed_hash IS NOT NULL`).all(store.extensionId,cutoff);
  store.db.transaction(()=>{
    for (const row of expired) {
      store.deleteWindow(row.window_id);
      store.db.query('DELETE FROM discord_relevance WHERE extension_id=? AND window_id=?').run(store.extensionId,row.window_id);
    }
    store.db.query(`DELETE FROM ${store.conversations} WHERE extension_id=? AND updated_at<?
      AND NOT EXISTS(SELECT 1 FROM ${store.messages} m WHERE m.extension_id=${store.conversations}.extension_id
        AND m.conversation_id=${store.conversations}.conversation_id)
      AND NOT EXISTS(SELECT 1 FROM ${store.windows} w WHERE w.extension_id=${store.conversations}.extension_id
        AND w.conversation_id=${store.conversations}.conversation_id AND w.source_id IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM discord_promotions p WHERE p.extension_id=${store.conversations}.extension_id
        AND p.conversation_id=${store.conversations}.conversation_id AND p.done=0)`).run(store.extensionId,cutoff);
  })();
  return {evicted,bytes,pinned:bytes>maxBytes};
}
