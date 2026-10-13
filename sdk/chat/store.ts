import type { Database } from "bun:sqlite";
import type { ChatConversation, ChatMessage, ChatWindowMessage } from "./types";
import { conversationHash } from "./conversation-hash";
import { chatHash } from "./hash";
export { chatHash } from "./hash";

const feed = (messageId: string) => messageId.slice(0, Math.max(0, messageId.indexOf(":")));

export interface UpsertOptions {
  /**
   * Skip a message when the conversation already holds one from another feed with identical
   * text and author name within this many milliseconds. Feeds are told apart by the message id
   * prefix before the first ":" (e.g. `export:…` vs `api:…`); used when two feeds lack shared ids.
   */
  nearDuplicateMs?: number;
}

/** Connector-owned raw message log. Raw messages never enter searchable chunks directly. */
export class ChatStore {
  readonly conversations: string;
  readonly messages: string;
  readonly windows: string;

  constructor(readonly db: Database, readonly extensionId: string, prefix: string) {
    if (!/^[a-z][a-z0-9_]*$/.test(prefix)) throw new Error(`Invalid chat table prefix ${prefix}`);
    this.conversations = `${prefix}_conversations`;
    this.messages = `${prefix}_messages`;
    this.windows = `${prefix}_windows`;
    db.run(`
      CREATE TABLE IF NOT EXISTS ${this.conversations} (
        extension_id TEXT NOT NULL, conversation_id TEXT NOT NULL, match_key TEXT,
        payload TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 1, scan_from INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(extension_id,conversation_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS ${this.conversations}_match ON ${this.conversations}(extension_id,match_key);
      CREATE TABLE IF NOT EXISTS ${this.messages} (
        extension_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
        sent_at INTEGER NOT NULL, content_hash TEXT NOT NULL, size INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(extension_id,conversation_id,message_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS ${this.messages}_order ON ${this.messages}(extension_id,conversation_id,sent_at,message_id);
      CREATE TABLE IF NOT EXISTS ${this.windows} (
        extension_id TEXT NOT NULL, window_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, message_hash TEXT NOT NULL,
        source_id TEXT, indexed_hash TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0, error TEXT,
        PRIMARY KEY(extension_id,window_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS ${this.windows}_conversation ON ${this.windows}(extension_id,conversation_id,start_time);
    `);
    if (!db.query<{name:string},[]>(`PRAGMA table_info(${this.windows})`).all().some(column=>column.name==='message_ids'))
      db.run(`ALTER TABLE ${this.windows} ADD COLUMN message_ids TEXT`);
  }

  /** Reuse an existing conversation that another feed registered under the same match key. */
  resolveConversationId(preferredId: string, matchKey?: string): string {
    if (this.conversation(preferredId) || !matchKey) return preferredId;
    return this.db.query<{ conversation_id: string }, [string, string]>(
      `SELECT conversation_id FROM ${this.conversations} WHERE extension_id=? AND match_key=? ORDER BY updated_at LIMIT 1`,
    ).get(this.extensionId, matchKey)?.conversation_id ?? preferredId;
  }

  upsertConversation(conversation: ChatConversation) {
    const previous = this.conversation(conversation.conversationId);
    const changed = previous && conversationHash(previous) !== conversationHash(conversation);
    this.db.query(`INSERT INTO ${this.conversations}(extension_id,conversation_id,match_key,payload,dirty,updated_at)
      VALUES(?,?,?,?,1,?) ON CONFLICT(extension_id,conversation_id) DO UPDATE SET
      match_key=coalesce(excluded.match_key,match_key),payload=excluded.payload,updated_at=excluded.updated_at,
      dirty=CASE WHEN ? THEN 1 ELSE dirty END,scan_from=CASE WHEN ? THEN 0 ELSE scan_from END`)
      .run(this.extensionId, conversation.conversationId, conversation.matchKey ?? null,
        JSON.stringify(conversation), Date.now(), changed ? 1 : 0, changed ? 1 : 0);
  }

  conversation(id: string): ChatConversation | null {
    const row = this.db.query<{ payload: string }, [string, string]>(
      `SELECT payload FROM ${this.conversations} WHERE extension_id=? AND conversation_id=?`).get(this.extensionId, id);
    return row ? JSON.parse(row.payload) : null;
  }

  /** Register a conversation (reusing one with the same match key) and upsert its messages. */
  ingest(conversation: ChatConversation, messages: ChatMessage[], options: UpsertOptions = {}) {
    const conversationId = this.resolveConversationId(conversation.conversationId, conversation.matchKey);
    const existing = this.conversation(conversationId);
    // A feed that matched an existing conversation keeps that conversation's identity and URI.
    this.upsertConversation(existing && conversationId !== conversation.conversationId
      ? { ...existing, title: conversation.title || existing.title } : { ...conversation, conversationId });
    return { conversationId, changed: this.upsertMessages(conversationId, messages, options) };
  }

  /** Messages of a conversation inside a closed time range. */
  messagesBetween(conversationId: string, start: number, end: number): ChatWindowMessage[] {
    return this.db.query<{ payload: string }, [string, string, number, number]>(
      `SELECT payload FROM ${this.messages} WHERE extension_id=? AND conversation_id=? AND sent_at BETWEEN ? AND ?
       ORDER BY sent_at,message_id`).all(this.extensionId, conversationId, start, end)
      .map(row => ({ ...JSON.parse(row.payload) as ChatMessage, conversationId }));
  }

  windowBySource(sourceId: string) {
    return this.db.query<{ window_id: string; conversation_id: string; start_time: number; end_time: number; message_hash: string;message_ids:string|null }, [string, string]>(
      `SELECT window_id,conversation_id,start_time,end_time,message_hash,message_ids FROM ${this.windows} WHERE extension_id=? AND source_id=?`)
      .get(this.extensionId, sourceId);
  }

  /** Insert new and edited messages; returns how many rows changed. */
  upsertMessages(conversationId: string, messages: ChatMessage[], options: UpsertOptions = {}): number {
    const upsert = this.db.query(`INSERT INTO ${this.messages}(extension_id,conversation_id,message_id,sent_at,content_hash,size,payload)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(extension_id,conversation_id,message_id) DO UPDATE SET
      sent_at=excluded.sent_at,content_hash=excluded.content_hash,size=excluded.size,payload=excluded.payload
      WHERE content_hash!=excluded.content_hash`);
    const nearby = this.db.query<{ payload: string }, [string, string, string, number, number]>(
      `SELECT payload FROM ${this.messages} WHERE extension_id=? AND conversation_id=? AND message_id!=? AND sent_at BETWEEN ? AND ?`);
    return this.db.transaction(() => {
      let changed = 0, earliest = Infinity;
      for (const message of messages) {
        const tolerance = options.nearDuplicateMs;
        if (tolerance !== undefined && nearby.all(this.extensionId, conversationId, message.messageId,
          message.sentAt - tolerance, message.sentAt + tolerance).some(row => {
            const other = JSON.parse(row.payload) as ChatMessage;
            return feed(other.messageId) !== feed(message.messageId)
              && other.text === message.text && other.authorName === message.authorName;
          })) continue;
        const payload = JSON.stringify(message);
        const size = message.text.length + message.authorName.length + 16 +
          message.attachments.reduce((n, a) => n + a.name.length + (a.text?.length ?? 0) + 12, 0);
        const rows = upsert.run(this.extensionId, conversationId, message.messageId, message.sentAt,
          chatHash(payload), size, payload).changes;
        if (rows) earliest = Math.min(earliest, message.sentAt);
        changed += rows;
      }
      if (changed) {
        // Rescan from the window that may absorb the earliest change; window starts are stable cut points.
        const from = this.db.query<{ start: number | null }, [string, string, number]>(
          `SELECT max(start_time) AS start FROM ${this.windows} WHERE extension_id=? AND conversation_id=? AND start_time<=?`)
          .get(this.extensionId, conversationId, earliest)?.start ?? 0;
        this.db.query(`UPDATE ${this.conversations} SET dirty=1,scan_from=min(scan_from,?) WHERE extension_id=? AND conversation_id=?`)
          .run(from, this.extensionId, conversationId);
      }
      return changed;
    })();
  }

  /** Delete messages of a conversation that are not in `keepIds`; returns how many were removed. */
  retainMessages(conversationId: string, keepIds: string[]): number {
    return this.db.query(`DELETE FROM ${this.messages} WHERE extension_id=? AND conversation_id=?
      AND message_id NOT IN (SELECT value FROM json_each(?))`)
      .run(this.extensionId, conversationId, JSON.stringify(keepIds)).changes;
  }

  loadMessages(conversationId: string, ids: string[]): ChatWindowMessage[] {
    const rows = this.db.query<{ payload: string }, [string, string, string]>(
      `SELECT payload FROM ${this.messages} WHERE extension_id=? AND conversation_id=?
       AND message_id IN (SELECT value FROM json_each(?)) ORDER BY sent_at,message_id`)
      .all(this.extensionId, conversationId, JSON.stringify(ids));
    return rows.map(row => ({ ...JSON.parse(row.payload) as ChatMessage, conversationId }));
  }

  latestSentAt(conversationId: string): number | null {
    return this.db.query<{ latest: number | null }, [string, string]>(
      `SELECT max(sent_at) AS latest FROM ${this.messages} WHERE extension_id=? AND conversation_id=?`)
      .get(this.extensionId, conversationId)?.latest ?? null;
  }

  dirtyConversations(): string[] {
    return this.db.query<{ conversation_id: string }, [string]>(
      `SELECT conversation_id FROM ${this.conversations} WHERE extension_id=? AND dirty=1 ORDER BY updated_at`)
      .all(this.extensionId).map(row => row.conversation_id);
  }

  scanFrom(conversationId: string): number {
    return this.db.query<{ scan_from: number }, [string, string]>(
      `SELECT scan_from FROM ${this.conversations} WHERE extension_id=? AND conversation_id=?`)
      .get(this.extensionId, conversationId)?.scan_from ?? 0;
  }

  /** Record scan progress; a concurrent upsert that lowered scan_from or re-dirtied the row wins. */
  finishScan(conversationId: string, scannedFrom: number, nextFrom: number, dirty: boolean) {
    this.db.query(`UPDATE ${this.conversations} SET dirty=?,scan_from=? WHERE extension_id=? AND conversation_id=? AND scan_from=?`)
      .run(dirty ? 1 : 0, nextFrom, this.extensionId, conversationId, scannedFrom);
  }

  windowState(windowId: string) {
    return this.db.query<{ message_hash: string; indexed_hash: string | null; attempts: number; next_attempt_at: number; source_id: string | null }, [string, string]>(
      `SELECT message_hash,indexed_hash,attempts,next_attempt_at,source_id FROM ${this.windows} WHERE extension_id=? AND window_id=?`)
      .get(this.extensionId, windowId);
  }

  recordWindow(windowId: string, conversationId: string, start: number, end: number, messageHash: string, messageIds?:string[]) {
    this.db.query(`INSERT INTO ${this.windows}(extension_id,window_id,conversation_id,start_time,end_time,message_hash,message_ids)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(extension_id,window_id) DO UPDATE SET start_time=excluded.start_time,
      end_time=excluded.end_time,attempts=CASE WHEN message_hash=excluded.message_hash THEN attempts ELSE 0 END,
      next_attempt_at=CASE WHEN message_hash=excluded.message_hash THEN next_attempt_at ELSE 0 END,
      message_hash=excluded.message_hash,message_ids=coalesce(excluded.message_ids,message_ids)`)
      .run(this.extensionId, windowId, conversationId, start, end, messageHash,messageIds ? JSON.stringify(messageIds) : null);
  }

  markIndexed(windowId: string, conversationId: string, start: number, end: number, messageHash: string, sourceId: string | null) {
    this.recordWindow(windowId, conversationId, start, end, messageHash);
    this.db.query(`UPDATE ${this.windows} SET indexed_hash=?,source_id=?,error=NULL,attempts=0,next_attempt_at=0
      WHERE extension_id=? AND window_id=?`).run(messageHash, sourceId, this.extensionId, windowId);
  }

  markFailed(windowId: string, error: unknown) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    this.db.query(`UPDATE ${this.windows} SET attempts=attempts+1,error=?,
      next_attempt_at=?+min(86400000,60000*(1<<min(attempts,10))) WHERE extension_id=? AND window_id=?`)
      .run(message, Date.now(), this.extensionId, windowId);
  }

  /** Admission or external coverage is pending; defer without exhausting failure attempts. */
  deferWindow(windowId: string, until: number) {
    this.db.query(`UPDATE ${this.windows} SET next_attempt_at=? WHERE extension_id=? AND window_id=?`)
      .run(until, this.extensionId, windowId);
  }

  /** Reevaluate unchanged history without deleting existing searchable sources first. */
  invalidate(conversationId: string) {
    this.db.query(`UPDATE ${this.windows} SET indexed_hash=NULL,attempts=0,next_attempt_at=0
      WHERE extension_id=? AND conversation_id=?`).run(this.extensionId, conversationId);
    this.db.query(`UPDATE ${this.conversations} SET dirty=1,scan_from=0 WHERE extension_id=? AND conversation_id=?`)
      .run(this.extensionId, conversationId);
  }

  /** Windows of a conversation that strictly overlap a time range, excluding one window. */
  overlappingWindows(conversationId: string, start: number, end: number, exceptId: string, messageIds?:string[]) {
    return this.db.query<{ window_id: string; source_id: string | null }, [string,string,string,number,number,string|null,string|null,string|null]>(
      `SELECT w.window_id,w.source_id FROM ${this.windows} w LEFT JOIN sources s ON s.id=w.source_id
       WHERE w.extension_id=? AND w.conversation_id=? AND w.window_id!=? AND (
         (w.start_time<? AND w.end_time>?)
         OR (? IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(w.message_ids) old
           JOIN json_each(?) current ON current.value=old.value))
         OR substr(s.uri,instr(s.uri,'#window=')+8) IN (SELECT value FROM json_each(?)))`)
      .all(this.extensionId,conversationId,exceptId,end,start,messageIds ? JSON.stringify(messageIds) : null,
        messageIds ? JSON.stringify(messageIds) : null,messageIds ? JSON.stringify(messageIds.map(encodeURIComponent)) : null);
  }

  deleteWindow(windowId: string) {
    this.db.query(`DELETE FROM ${this.windows} WHERE extension_id=? AND window_id=?`).run(this.extensionId, windowId);
  }

  stats() {
    const count = (table: string) => this.db.query<{ n: number }, [string]>(
      `SELECT count(*) AS n FROM ${table} WHERE extension_id=?`).get(this.extensionId)!.n;
    return { conversations: count(this.conversations), messages: count(this.messages), windows: count(this.windows) };
  }
}
