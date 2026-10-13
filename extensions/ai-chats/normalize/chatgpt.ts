/**
 * ChatGPT conversation JSON (the web app's `/backend-api/conversation/<id>`, which is also the
 * shape of `conversations.json` in a data export) → the active branch as plain messages.
 */
import type { AiChatAttachment, AiChatMessage, NormalizedConversation } from "../contract";
import { toMs } from "./time";

interface ChatGptNode {
  id: string;
  parent?: string | null;
  children?: string[];
  message?: {
    id: string;
    author?: { role?: string };
    create_time?: number | null;
    recipient?: string;
    content?: { content_type?: string; parts?: unknown[]; text?: string };
    metadata?: Record<string, any>;
  } | null;
}

export interface ChatGptConversation {
  id?: string;
  conversation_id?: string;
  title?: string | null;
  create_time?: number | string | null;
  update_time?: number | string | null;
  current_node?: string | null;
  mapping?: Record<string, ChatGptNode>;
}

const TEXT_CONTENT = new Set(["text", "multimodal_text"]);
/** Inline citation markers such as `citeturn0search1` render as nothing. */
const CITATION = /[^]*/g;

/** Walk from the visible leaf to the root; edits and regenerations live on other branches. */
function activePath(mapping: Record<string, ChatGptNode>, currentNode?: string | null): ChatGptNode[] {
  let leaf = currentNode && mapping[currentNode] ? currentNode : undefined;
  if (!leaf) {
    const leaves = Object.values(mapping).filter(node => !node.children?.length);
    leaf = leaves.sort((a, b) => (a.message?.create_time ?? 0) - (b.message?.create_time ?? 0)).at(-1)?.id;
  }
  const path: ChatGptNode[] = [];
  const seen = new Set<string>();
  for (let id = leaf; id && mapping[id] && !seen.has(id); id = mapping[id]!.parent ?? undefined) {
    seen.add(id);
    path.push(mapping[id]!);
  }
  return path.reverse();
}

function partsOf(node: NonNullable<ChatGptNode["message"]>): { text: string; attachments: AiChatAttachment[] } {
  const texts: string[] = [];
  const attachments: AiChatAttachment[] = [];
  for (const part of node.content?.parts ?? []) {
    if (typeof part === "string") texts.push(part);
    else if (part && typeof part === "object") {
      const item = part as Record<string, any>;
      if (item.content_type === "image_asset_pointer") attachments.push({ kind: "image", name: "image" });
      else if (typeof item.text === "string") texts.push(item.text);
    }
  }
  if (!texts.length && typeof node.content?.text === "string") texts.push(node.content.text);
  for (const file of node.metadata?.attachments ?? [])
    if (file && typeof file.name === "string")
      attachments.push({ kind: String(file.mime_type ?? "").startsWith("image/") ? "image" : "file", name: file.name.slice(0, 500) });
  return { text: texts.join("\n").replace(CITATION, "").trim(), attachments };
}

export function normalizeChatGpt(raw: ChatGptConversation, fallbackId?: string): NormalizedConversation {
  const conversationId = raw.conversation_id || raw.id || fallbackId;
  if (!conversationId) throw new Error("ChatGPT conversation has no id");
  if (!raw.mapping || typeof raw.mapping !== "object") throw new Error("ChatGPT conversation has no message tree");
  const messages: AiChatMessage[] = [];
  for (const node of activePath(raw.mapping, raw.current_node)) {
    const message = node.message;
    const role = message?.author?.role;
    if (!message || (role !== "user" && role !== "assistant")) continue;
    if (message.recipient && message.recipient !== "all") continue;
    if (message.metadata?.is_visually_hidden_from_conversation) continue;
    if (!TEXT_CONTENT.has(message.content?.content_type ?? "")) continue;
    const { text, attachments } = partsOf(message);
    if (!text && !attachments.length) continue;
    messages.push({ id: message.id, role, sentAt: toMs(message.create_time), text, attachments });
  }
  return {
    provider: "chatgpt",
    conversationId,
    title: raw.title?.trim() || "Untitled chat",
    url: `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`,
    createdAt: toMs(raw.create_time),
    updatedAt: toMs(raw.update_time),
    pathIds: messages.map(message => message.id),
    messages,
  };
}
