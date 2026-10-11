/** Platform-neutral chat records shared by message connectors (Discord, Instagram, …). */

export interface ChatAttachment {
  name: string;
  kind: "image" | "video" | "audio" | "file" | "link" | "sticker" | "embed";
  url?: string;
  /** Extra searchable text, e.g. an embed's title and description or a shared post's caption. */
  text?: string;
}

export interface ChatReaction {
  emoji: string;
  count: number;
}

export interface ChatMessage {
  messageId: string;
  /** Platform user id, or a scoped fallback such as `name:<display name>` when the platform export has no ids. */
  authorId: string;
  authorName: string;
  /** Epoch milliseconds. */
  sentAt: number;
  editedAt?: number;
  text: string;
  replyToId?: string;
  attachments: ChatAttachment[];
  reactions?: ChatReaction[];
  isBot?: boolean;
  /** Joins, pins, calls, and other platform notices; stored but omitted from transcripts. */
  isSystem?: boolean;
}

export interface ChatParticipant {
  id: string;
  name: string;
  /** Present only when `id` is a real platform identifier (never for name-only fallbacks). */
  externalId?: string;
  isBot?: boolean;
}

export interface ChatConversation {
  conversationId: string;
  title: string;
  kind: "dm" | "group" | "channel" | "thread";
  /** Stable connector URI for the conversation, e.g. `discord://channel/<id>`. */
  uri: string;
  server?: { id: string; name: string; uri: string };
  /** Optional key used to recognise the same conversation arriving from a different feed. */
  matchKey?: string;
}

export interface ChatWindowMessage extends ChatMessage {
  conversationId: string;
}

/** A sealed, time-bounded slice of one conversation that becomes one source. */
export interface ChatWindow {
  windowId: string;
  conversation: ChatConversation;
  messages: ChatWindowMessage[];
  startTime: number;
  endTime: number;
  /** Fingerprint of message ids and contents; changes when a message is edited, added, or removed. */
  messageHash: string;
}

export interface ChatSynthesis {
  method: "llm" | "heuristic";
  model?: string;
  title: string;
  summary: string;
  topics: string[];
}

export interface ChatWindowSettings {
  /** A silence longer than this starts a new window. */
  gapMinutes?: number;
  /** Upper bound on messages per window. */
  maxWindowMessages?: number;
  /** Upper bound on transcript characters per window, kept within the source memory budget. */
  maxWindowChars?: number;
  /** A trailing window is only indexed after this much silence. */
  idleMinutes?: number;
  maxAttempts?: number;
  /** Maximum windows indexed per run. */
  maxWindowsPerRun?: number;
  summarize?: boolean;
  llmModel?: string;
  excludeBots?: boolean;
}

export interface PreparedChatWindow {
  type: "chat_window";
  platform: string;
  namespace: string;
  windowId: string;
  conversation: ChatConversation;
  startTime: number;
  endTime: number;
  messageCount: number;
  messageHash: string;
  firstMessageId: string;
  participants: Array<ChatParticipant & { messages: number }>;
  synthesis: ChatSynthesis;
  sourceHash: string;
  memory: import("../../lib/memory/types").PreparedSourceMemory;
}
