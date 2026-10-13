/**
 * Claude.ai conversation JSON (the web app's
 * `/api/organizations/<org>/chat_conversations/<id>?tree=True&rendering_mode=messages`,
 * also the shape of `conversations.json` in a data export) → the active branch as plain messages.
 */
import type { AiChatAttachment, AiChatMessage, NormalizedConversation } from "../contract";
import { toMs } from "./time";

interface ClaudeFile { file_name?: string; file_kind?: string }

interface ClaudeMessage {
  uuid: string;
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
  sender?: string;
  index?: number;
  created_at?: string;
  parent_message_uuid?: string | null;
  attachments?: ClaudeFile[];
  files?: ClaudeFile[];
  files_v2?: ClaudeFile[];
}

export interface ClaudeConversation {
  uuid?: string;
  name?: string | null;
  created_at?: string;
  updated_at?: string;
  current_leaf_message_uuid?: string | null;
  chat_messages?: ClaudeMessage[];
}

/** Follow parents from the current leaf; without tree data, keep the export's order. */
function activePath(messages: ClaudeMessage[], leafId?: string | null): ClaudeMessage[] {
  const byId = new Map(messages.map(message => [message.uuid, message]));
  const hasTree = messages.some(message => message.parent_message_uuid);
  let leaf = leafId ? byId.get(leafId) : undefined;
  if (!leaf && hasTree) {
    const parents = new Set(messages.map(message => message.parent_message_uuid));
    leaf = messages.filter(message => !parents.has(message.uuid))
      .sort((a, b) => (toMs(a.created_at) ?? 0) - (toMs(b.created_at) ?? 0)).at(-1);
  }
  if (!leaf) return [...messages].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const path: ClaudeMessage[] = [];
  const seen = new Set<string>();
  for (let node: ClaudeMessage | undefined = leaf; node && !seen.has(node.uuid);
    node = node.parent_message_uuid ? byId.get(node.parent_message_uuid) : undefined) {
    seen.add(node.uuid);
    path.push(node);
  }
  return path.reverse();
}

function attachmentsOf(message: ClaudeMessage): AiChatAttachment[] {
  const names = new Map<string, AiChatAttachment>();
  for (const file of [...(message.attachments ?? []), ...(message.files ?? []), ...(message.files_v2 ?? [])]) {
    const name = file?.file_name?.trim().slice(0, 500);
    if (name && !names.has(name)) names.set(name, { kind: file.file_kind === "image" ? "image" : "file", name });
  }
  return [...names.values()];
}

/** Visible text only: thinking, tool calls, and tool results are skipped. */
function textOf(message: ClaudeMessage): string {
  if (Array.isArray(message.content) && message.content.length)
    return message.content.filter(block => block?.type === "text" && typeof block.text === "string")
      .map(block => block.text!.trim()).filter(Boolean).join("\n\n");
  return (message.text ?? "").trim();
}

export function normalizeClaude(raw: ClaudeConversation, fallbackId?: string): NormalizedConversation {
  const conversationId = raw.uuid || fallbackId;
  if (!conversationId) throw new Error("Claude conversation has no id");
  if (!Array.isArray(raw.chat_messages)) throw new Error("Claude conversation has no messages");
  const messages: AiChatMessage[] = [];
  let previous: number | undefined;
  for (const message of activePath(raw.chat_messages, raw.current_leaf_message_uuid)) {
    const role = message.sender === "human" ? "user" : message.sender === "assistant" ? "assistant" : undefined;
    if (!role || !message.uuid) continue;
    const text = textOf(message);
    const attachments = attachmentsOf(message);
    if (!text && !attachments.length) continue;
    // Keep the transcript ordered when a timestamp is missing or out of order.
    const created = toMs(message.created_at);
    const sentAt = created === undefined ? (previous === undefined ? undefined : previous + 1)
      : Math.max(created, previous === undefined ? 0 : previous + 1);
    if (sentAt !== undefined) previous = sentAt;
    messages.push({ id: message.uuid, role, sentAt, text, attachments });
  }
  return {
    provider: "claude",
    conversationId,
    title: raw.name?.trim() || "Untitled chat",
    url: `https://claude.ai/chat/${encodeURIComponent(conversationId)}`,
    createdAt: toMs(raw.created_at),
    updatedAt: toMs(raw.updated_at),
    pathIds: messages.map(message => message.id),
    messages,
  };
}
