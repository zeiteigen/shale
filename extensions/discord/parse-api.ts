import type { ChatAttachment, ChatConversation, ChatMessage } from "@shale/sdk/chat/types";


function attachmentKind(name: string): ChatAttachment["kind"] {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "heic"].includes(ext)) return "image";
  if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "video";
  if (["mp3", "ogg", "wav", "flac", "m4a", "opus"].includes(ext)) return "audio";
  return "file";
}

export function parseAPIConversation(raw: any, server?: { id: string; name: string }): ChatConversation {
  const type = Number(raw?.type);
  const thread = [10, 11, 12].includes(type);
  const dm = type === 1;
  const group = type === 3;
  const kind: ChatConversation["kind"] = thread ? "thread" : dm ? "dm" : group ? "group" : "channel";
  const name = typeof raw?.name === "string" ? raw.name : "Direct Message";
  const inGuild = !dm && !group && !!server;
  const title = inGuild ? `#${name}` : name;
  return {
    conversationId: String(raw?.id ?? ""), kind, title,
    uri: `discord://channel/${String(raw?.id ?? "")}`,
    server: inGuild ? { ...server!, uri: `discord://guild/${server!.id}` } : undefined,
    ...(thread && raw?.parent_id ? { parentId: String(raw.parent_id) } : {}),
  };
}

export function parseAPIMessage(raw: any, selfUserIds: string[], tokenUserId?: string): ChatMessage | null {
  if (!raw || raw.id == null || raw.author?.id == null) return null;
  const sentAt = Date.parse(raw.timestamp);
  if (!Number.isFinite(sentAt)) return null;
  const edited = raw.edited_timestamp ? Date.parse(raw.edited_timestamp) : NaN;
  const author = raw.author;
  const memberNick = raw.member?.nick;
  const authorName = memberNick || author.global_name || author.username || author.name;
  if (!authorName) return null;
  const attachments: ChatAttachment[] = [
    ...(Array.isArray(raw.attachments) ? raw.attachments : []).map((a: any) => {
      const name = a.filename || a.name || a.url?.split("/").pop()?.split("?")[0] || "attachment";
      return { name, kind: attachmentKind(name), url: a.url ?? undefined };
    }),
    ...(Array.isArray(raw.embeds) ? raw.embeds : []).filter((e: any) => e.title || e.url || e.description).map((e: any) => ({
      kind: (e.url && !e.description && !e.title ? "link" : "embed") as ChatAttachment["kind"],
      name: e.title || e.url || "embed", url: e.url ?? undefined,
      text: e.description ? String(e.description).replace(/\s+/g, " ").slice(0, 300) : undefined,
    })),
    ...(Array.isArray(raw.sticker_items) ? raw.sticker_items : []).map((s: any) => ({ name: s.name || "sticker", kind: "sticker" as const })),
  ];
  const allowedSelf = tokenUserId && selfUserIds.includes(tokenUserId) ? tokenUserId : undefined;
  const reactedUserIds:string[] = allowedSelf && Array.isArray(raw.reactions) && raw.reactions.some((r:any)=>r.me || r.me_burst)
    ? [allowedSelf] : [];
  const reference = raw.message_reference;
  const sameChannel = !reference?.channel_id || String(reference.channel_id) === String(raw.channel_id);
  const types = Number(raw.type);
  const result: ChatMessage = {
    messageId: String(raw.id), authorId: String(author.id), authorName, sentAt,
    editedAt: Number.isFinite(edited) ? edited : undefined,
    text: typeof raw.content === "string" ? raw.content : "",
    replyToId: reference?.message_id ? String(reference.message_id) : undefined,
    replyConversationId: reference?.channel_id && !sameChannel ? String(reference.channel_id) : undefined,
    attachments,
    reactions: Array.isArray(raw.reactions) && raw.reactions.length ? raw.reactions.map((r: any) => ({
      emoji: r.emoji?.name || r.emoji?.id || "?", count: Number(r.count) || 0,
    })) : undefined,
    mentionedUserIds: Array.isArray(raw.mentions) ? raw.mentions.map((u: any) => String(u.id)).filter(Boolean) : undefined,
    reactedUserIds: reactedUserIds.length ? reactedUserIds : undefined,
    isBot: author.bot === true || undefined,
    isSystem: types !== 0 && types !== 19 && types !== 21 || undefined,
  };
  return result;
}
