import { basename, dirname } from "node:path";
import { z } from "zod";
import { chatHash } from "@shale/sdk/chat/store";
import type { ChatAttachment, ChatConversation, ChatMessage } from "@shale/sdk/chat/types";
import { fixMojibakeDeep } from "./mojibake";
import { participantMatchKey } from "./connector";

const media = z.array(z.object({ uri: z.string().nullish() })).nullish();

const message = z.object({
  sender_name: z.string(),
  timestamp_ms: z.number(),
  content: z.string().nullish(),
  photos: media, videos: media, audio_files: media, gifs: media, files: media,
  sticker: z.object({ uri: z.string().nullish() }).nullish(),
  share: z.object({ link: z.string().nullish(), share_text: z.string().nullish(), original_content_owner: z.string().nullish() }).nullish(),
  reactions: z.array(z.object({ reaction: z.string(), actor: z.string().nullish() })).nullish(),
  call_duration: z.number().nullish(),
  is_unsent: z.boolean().nullish(),
});

const thread = z.object({
  participants: z.array(z.object({ name: z.string() })).default([]),
  messages: z.array(z.unknown()).default([]),
  title: z.string().nullish(),
  thread_path: z.string().nullish(),
});

/** Auto-generated notices Instagram stores as message content. */
const SYSTEM_CONTENT = [
  /^Liked a message$/i, /reacted .{1,8} to your message/i, /^.{1,80} (started|ended) (a )?(video|audio) (chat|call)$/i,
  /^You missed (a|an) (video|audio) (chat|call)$/i, /^.{1,80} sent an attachment\.$/i, /^This message was unsent\.?$/i,
  /^.{1,80} (named the group|changed the theme|set the nickname|added .{1,80} to the group|left the group)/i,
];

function attachments(m: z.infer<typeof message>): ChatAttachment[] {
  const files = (items: z.infer<typeof media>, kind: ChatAttachment["kind"]) =>
    (items ?? []).map(item => ({ name: basename(item.uri ?? kind), kind, url: item.uri ?? undefined }));
  const result: ChatAttachment[] = [
    ...files(m.photos, "image"), ...files(m.gifs, "image"), ...files(m.videos, "video"),
    ...files(m.audio_files, "audio"), ...files(m.files, "file"),
  ];
  if (m.sticker) result.push({ name: "sticker", kind: "sticker" });
  if (m.share?.link || m.share?.share_text) result.push({
    kind: "link", name: m.share.original_content_owner ? `post by ${m.share.original_content_owner}` : (m.share.link ?? "shared post"),
    url: m.share.link ?? undefined, text: m.share.share_text?.replace(/\s+/g, " ").slice(0, 300) || undefined,
  });
  return result;
}

export interface ParsedInstagramThread {
  /** Thread folder name, e.g. `alice_1234567890`. */
  folder: string;
  conversation: ChatConversation;
  messages: ChatMessage[];
  skipped: number;
}

/** Parse one `message_N.json`; the thread folder names the conversation because the export has no thread ids. */
export function parseInstagramThread(raw: unknown, path: string): ParsedInstagramThread {
  const file = thread.parse(fixMojibakeDeep(raw));
  const folder = basename(dirname(path));
  const names = file.participants.map(p => p.name);
  const title = file.title?.trim() || names.join(", ") || folder;
  const conversationId = `export:${folder}`;
  const conversation: ChatConversation = {
    conversationId, title, kind: names.length > 2 ? "group" : "dm",
    uri: `instagram://thread/${encodeURIComponent(conversationId)}`, matchKey: participantMatchKey(names),
  };
  const messages: ChatMessage[] = [];
  let skipped = 0;
  for (const item of file.messages) {
    const parsed = message.safeParse(item);
    if (!parsed.success) { skipped++; continue; }
    const m = parsed.data;
    const files = attachments(m);
    // "X sent an attachment." only labels the attachment; keep the attachment, drop the label.
    const text = files.length && /sent an attachment\.$/i.test(m.content ?? "") ? "" : m.content ?? "";
    const reactionCounts = new Map<string, number>();
    for (const r of m.reactions ?? []) reactionCounts.set(r.reaction, (reactionCounts.get(r.reaction) ?? 0) + 1);
    messages.push({
      messageId: `export:${chatHash([folder, m.timestamp_ms, m.sender_name, m.content ?? ""])}`,
      authorId: `name:${m.sender_name}`,
      authorName: m.sender_name,
      sentAt: m.timestamp_ms,
      text,
      attachments: files,
      reactions: reactionCounts.size ? [...reactionCounts].map(([emoji, count]) => ({ emoji, count })) : undefined,
      isSystem: m.call_duration != null || !!m.is_unsent || SYSTEM_CONTENT.some(pattern => pattern.test(text)) || undefined,
    });
  }
  // Export files list messages newest first.
  messages.sort((a, b) => a.sentAt - b.sentAt);
  return { folder, conversation, messages, skipped };
}
