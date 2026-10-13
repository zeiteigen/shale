import type { ShaleSDK } from "@shale/sdk";
import type { ChatStore } from "@shale/sdk/chat/store";
import { chatHash } from "@shale/sdk/chat/hash";
import type { ChatConversation, ChatMessage, ChatWindow } from "@shale/sdk/chat/types";

export interface RelevanceDecision {
  status: "accepted" | "excluded" | "pending";
  fingerprint: string;
  reason: string;
  score: number;
  participantIds: string[];
  revision: number;
  retryAt?: number;
}
export interface PromotionJob {
  id: string; conversation_id: string; anchor_id: string | null; reason: string;
  cursor: string | null; fetched: number; retry_at: number;
}

/** Private connector state: none of these tables are exposed to graph consumers. */
export class DiscordRelevanceStore {
  constructor(readonly sdk: ShaleSDK, readonly chat: ChatStore) {
    sdk.database.run(`CREATE TABLE IF NOT EXISTS discord_relevance (
      extension_id TEXT NOT NULL,window_id TEXT NOT NULL,conversation_id TEXT NOT NULL,
      message_hash TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,
      reason TEXT NOT NULL,score REAL NOT NULL,participants TEXT NOT NULL,message_ids TEXT NOT NULL,
      raw_available INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL,
      PRIMARY KEY(extension_id,window_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS discord_relevance_conversation ON discord_relevance(extension_id,conversation_id);
    CREATE TABLE IF NOT EXISTS discord_activity (
      extension_id TEXT NOT NULL,conversation_id TEXT NOT NULL,anchor_id TEXT NOT NULL,
      sent_at INTEGER NOT NULL,author_id TEXT NOT NULL,reason TEXT NOT NULL,
      PRIMARY KEY(extension_id,conversation_id,anchor_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS discord_contacts (
      extension_id TEXT NOT NULL,user_id TEXT NOT NULL,last_seen INTEGER NOT NULL,PRIMARY KEY(extension_id,user_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS discord_promotions (
      extension_id TEXT NOT NULL,id TEXT NOT NULL,conversation_id TEXT NOT NULL,anchor_id TEXT,
      reason TEXT NOT NULL,cursor TEXT,fetched INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,
      done INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,
      PRIMARY KEY(extension_id,id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS discord_coverage (
      extension_id TEXT NOT NULL,conversation_id TEXT NOT NULL,mode TEXT NOT NULL,
      detail TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(extension_id,conversation_id)
    ) STRICT`);
    if (!sdk.database.query<{name:string},[]>("PRAGMA table_info(discord_relevance)").all().some(column=>column.name==='version'))
      sdk.database.run("ALTER TABLE discord_relevance ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
  }

  decision(window: ChatWindow, fingerprint: string): RelevanceDecision | null {
    const row = this.sdk.database.query<{message_hash:string;fingerprint:string;status:RelevanceDecision['status'];reason:string;score:number;participants:string;version:number},[string,string]>(
      `SELECT * FROM discord_relevance WHERE extension_id=? AND window_id=?`).get(this.chat.extensionId, window.windowId);
    return row && row.message_hash === window.messageHash && row.fingerprint === fingerprint && row.status !== "pending"
      ? {status:row.status,reason:row.reason,score:row.score,participantIds:JSON.parse(row.participants),fingerprint,revision:row.version} : null;
  }

  save(window: ChatWindow, decision: RelevanceDecision) {
    this.sdk.database.query(`INSERT INTO discord_relevance
      (extension_id,window_id,conversation_id,message_hash,fingerprint,status,reason,score,participants,message_ids,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(extension_id,window_id) DO UPDATE SET
      version=CASE WHEN message_hash!=excluded.message_hash OR fingerprint!=excluded.fingerprint
        OR status!=excluded.status OR participants!=excluded.participants THEN version+1 ELSE version END,
      message_hash=excluded.message_hash,fingerprint=excluded.fingerprint,status=excluded.status,reason=excluded.reason,
      score=excluded.score,participants=excluded.participants,message_ids=excluded.message_ids,raw_available=1,updated_at=excluded.updated_at`)
      .run(this.chat.extensionId,window.windowId,window.conversation.conversationId,window.messageHash,decision.fingerprint,
        decision.status,decision.reason,decision.score,JSON.stringify(decision.participantIds),
        JSON.stringify(window.messages.map(message => message.messageId)),Date.now());
    decision.revision=this.sdk.database.query<{version:number},[string,string]>(
      "SELECT version FROM discord_relevance WHERE extension_id=? AND window_id=?").get(this.chat.extensionId,window.windowId)!.version;
  }

  signalFingerprint(conversationId: string) {
    const signals = this.sdk.database.query<{anchor_id:string;reason:string},[string,string]>(
      `SELECT anchor_id,reason FROM discord_activity WHERE extension_id=? AND conversation_id=? ORDER BY anchor_id`)
      .all(this.chat.extensionId,conversationId);
    return chatHash(signals);
  }

  joined(conversationId: string) {
    return !!this.sdk.database.query("SELECT 1 FROM discord_activity WHERE extension_id=? AND conversation_id=? AND reason='joined'")
      .get(this.chat.extensionId,conversationId);
  }

  observe(conversation: ChatConversation, messages: ChatMessage[], self: string[]) {
    if (!self.length) return;
    const own = new Set(self);
    const ids = new Set(messages.filter(message => own.has(message.authorId)).map(message => message.messageId));
    const byId = new Map(messages.map(message => [message.messageId,message]));
    for (const message of messages) {
      if (message.isSystem || message.isBot) continue;
      let reason = own.has(message.authorId) ? "authored"
        : message.mentionedUserIds?.some(id => own.has(id)) ? "mentioned"
        : message.reactedUserIds?.some(id => own.has(id)) ? "reacted" : "";
      if (!reason && message.replyToId) {
        const target = byId.get(message.replyToId) ?? this.chat.loadMessages(message.replyConversationId ?? conversation.conversationId,[message.replyToId])[0];
        if (ids.has(message.replyToId) || target && own.has(target.authorId)) reason="reply";
      }
      if (reason) this.promote(conversation.conversationId,message.messageId,message.sentAt,message.authorId,reason);
      const replied=message.replyToId ? byId.get(message.replyToId)
        ?? this.chat.loadMessages(message.replyConversationId ?? conversation.conversationId,[message.replyToId])[0] : undefined;
      const people=own.has(message.authorId)
        ? [...(message.mentionedUserIds ?? []),...(replied ? [replied.authorId] : [])]
        : reason || conversation.kind === 'dm' || conversation.kind === 'group' ? [message.authorId] : [];
      for (const id of people.filter(id=>!own.has(id))) {
        const inserted=this.sdk.database.query(`INSERT INTO discord_contacts VALUES(?,?,?)
          ON CONFLICT(extension_id,user_id) DO UPDATE SET last_seen=excluded.last_seen WHERE last_seen<excluded.last_seen`)
          .run(this.chat.extensionId,id,message.sentAt);
        if (inserted.changes) {
          for (const row of this.sdk.database.query<{conversation_id:string},[string,string]>(
            `SELECT DISTINCT conversation_id FROM ${this.chat.messages} WHERE extension_id=?
             AND json_extract(payload,'$.authorId')=? LIMIT 20`).all(this.chat.extensionId,id)) this.chat.invalidate(row.conversation_id);
        }
      }
    }
  }

  promote(conversationId: string, anchorId: string, sentAt: number, authorId: string, reason: string) {
    this.sdk.database.transaction(() => {
      const inserted = this.sdk.database.query(`INSERT OR IGNORE INTO discord_activity VALUES(?,?,?,?,?,?)`)
        .run(this.chat.extensionId,conversationId,anchorId,sentAt,authorId,reason).changes;
      if (!inserted) return;
      this.chat.invalidate(conversationId);
      if (reason==='referenced') return;
      const jobId=chatHash([conversationId,"context"]);
      this.sdk.database.query(`INSERT INTO discord_promotions
        (extension_id,id,conversation_id,anchor_id,reason,created_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(extension_id,id) DO UPDATE SET done=0,anchor_id=excluded.anchor_id,reason=excluded.reason,
          cursor=NULL,fetched=0,retry_at=0,created_at=excluded.created_at WHERE done=1`)
        .run(this.chat.extensionId,jobId,conversationId,anchorId === "joined" ? null : anchorId,reason,Date.now());
      // A new direct contact can make previous discussions with that person worth reconsidering.
      if (reason !== "joined" && authorId) {
        const related = this.sdk.database.query<{conversation_id:string},[string,string]>(
          `SELECT DISTINCT conversation_id FROM ${this.chat.messages} WHERE extension_id=?
           AND json_extract(payload,'$.authorId')=? LIMIT 20`).all(this.chat.extensionId,authorId);
        for (const row of related) this.chat.invalidate(row.conversation_id);
      }
    })();
  }

  contacts(): Set<string> {
    return new Set(this.sdk.database.query<{author_id:string},[string]>(
      "SELECT user_id AS author_id FROM discord_contacts WHERE extension_id=?")
      .all(this.chat.extensionId).map(row=>row.author_id));
  }

  jobs(): PromotionJob[] {
    return this.sdk.database.query<PromotionJob,[string,number]>(
      "SELECT * FROM discord_promotions WHERE extension_id=? AND done=0 AND retry_at<=? ORDER BY created_at,id LIMIT 20")
      .all(this.chat.extensionId,Date.now());
  }

  jobProgress(job: PromotionJob, cursor: string | null, fetched: number, done: boolean, retryAt=0) {
    this.sdk.database.query(`UPDATE discord_promotions SET cursor=?,fetched=?,done=?,retry_at=? WHERE extension_id=? AND id=?`)
      .run(cursor,fetched,done?1:0,retryAt,this.chat.extensionId,job.id);
  }

  coverage(conversationId: string, mode: "sampled" | "complete" | "incomplete", detail: string) {
    this.sdk.database.query(`INSERT INTO discord_coverage VALUES(?,?,?,?,?) ON CONFLICT(extension_id,conversation_id)
      DO UPDATE SET mode=excluded.mode,detail=excluded.detail,updated_at=excluded.updated_at`)
      .run(this.chat.extensionId,conversationId,mode,detail.slice(0,500),Date.now());
  }
}
