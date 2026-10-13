import type { ChatConversation, ChatMessage, ChatWindow, PreparedChatWindow } from "./types";

export interface ChatWindowDecision {
  status: "accepted" | "excluded" | "pending";
  fingerprint: string;
  participantIds?: string[];
  revision?: number;
  retryAt?: number;
}

/** Connector-specific admission; the shared writer still owns atomic graph commits. */
export interface ChatWindowPolicy {
  readonly deadline?: number;
  fingerprint(conversationId: string): string;
  decide(window: ChatWindow): Promise<ChatWindowDecision>;
  exclude(window: ChatWindow): Promise<void>;
  observe?(conversation: ChatConversation, messages: ChatMessage[]): void;
  ingest?(conversation: ChatConversation, messages: ChatMessage[]): {conversationId:string;changed:number};
  reconcile?(data: PreparedChatWindow, sourceId: string): void;
  restore?(windowId: string): Promise<void>;
  preserve?(sourceId: string): boolean;
}
