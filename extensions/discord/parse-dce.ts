import { z } from "zod";
import type { ChatAttachment, ChatConversation, ChatMessage } from "@shale/sdk/chat/types";

const nullableString = z.string().nullish();

const author = z.object({
  id: z.string(), name: z.string(), nickname: nullableString, isBot: z.boolean().nullish(),
});

const message = z.object({
  id: z.string(),
  type: z.string().default("Default"),
  timestamp: z.string(),
  timestampEdited: nullableString,
  content: z.string().default(""),
  author,
  attachments: z.array(z.object({ url: nullableString, fileName: nullableString })).default([]),
  embeds: z.array(z.object({ title: nullableString, url: nullableString, description: nullableString })).default([]),
  stickers: z.array(z.object({ name: nullableString })).default([]),
  reactions: z.array(z.object({ emoji: z.object({ name: nullableString, code: nullableString }), count: z.number(),
    users: z.array(z.object({ id: z.string() })).default([]) })).default([]),
  mentions: z.array(z.object({ id: z.string() })).default([]),
  reference: z.object({ messageId: nullableString, channelId: nullableString }).nullish(),
});

const exportFile = z.object({
  guild: z.object({ id: z.string(), name: z.string() }),
  channel: z.object({
    id: z.string(), type: z.string().default("GuildTextChat"), name: z.string(),
    category: nullableString, categoryId: nullableString,
  }),
  messages: z.array(z.unknown()),
});

/** DiscordChatExporter message types that are notices rather than conversation. */
const SYSTEM_TYPES = new Set([
  "RecipientAdd", "RecipientRemove", "Call", "ChannelNameChange", "ChannelIconChange", "ChannelPinnedMessage",
  "GuildMemberJoin", "ThreadCreated", "GuildBoost", "GuildBoostTier1", "GuildBoostTier2", "GuildBoostTier3",
  "ChannelFollowAdd", "AutoModerationAction",
]);

const DM_GUILD_ID = "0";

function attachmentKind(name: string): ChatAttachment["kind"] {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "heic"].includes(ext)) return "image";
  if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "video";
  if (["mp3", "ogg", "wav", "flac", "m4a", "opus"].includes(ext)) return "audio";
  return "file";
}

function conversationKind(type: string, guildId: string): ChatConversation["kind"] {
  if (/thread/i.test(type)) return "thread";
  if (type === "DirectGroupTextChat") return "group";
  if (type === "DirectTextChat" || guildId === DM_GUILD_ID) return "dm";
  return "channel";
}

export interface ParsedDiscordExport {
  conversation: ChatConversation;
  messages: ChatMessage[];
  skipped: number;
}

/** Parse one DiscordChatExporter `-f Json` file; malformed messages are skipped, not fatal. */
export function parseDiscordExport(raw: unknown): ParsedDiscordExport {
  const file = exportFile.parse(raw);
  const { guild, channel } = file;
  const kind = conversationKind(channel.type, guild.id);
  const inGuild = guild.id !== DM_GUILD_ID && kind !== "dm" && kind !== "group";
  const title = inGuild
    ? (kind === "thread" && channel.category ? `#${channel.category} › ${channel.name}` : `#${channel.name}`)
    : channel.name;
  const conversation: ChatConversation = {
    conversationId: channel.id, kind, title, uri: `discord://channel/${channel.id}`,
    server: inGuild ? { id: guild.id, name: guild.name, uri: `discord://guild/${guild.id}` } : undefined,
    parentId: kind === "thread" ? channel.categoryId ?? undefined : undefined,
  };
  const messages: ChatMessage[] = [];
  let skipped = 0;
  for (const item of file.messages) {
    const parsed = message.safeParse(item);
    const sentAt = parsed.success ? Date.parse(parsed.data.timestamp) : NaN;
    if (!parsed.success || Number.isNaN(sentAt)) { skipped++; continue; }
    const m = parsed.data;
    const edited = m.timestampEdited ? Date.parse(m.timestampEdited) : NaN;
    const attachments: ChatAttachment[] = [
      ...m.attachments.map(a => {
        const name = a.fileName || a.url?.split("/").pop()?.split("?")[0] || "attachment";
        return { name, kind: attachmentKind(name), url: a.url ?? undefined };
      }),
      ...m.embeds.filter(e => e.title || e.url || e.description).map(e => ({
        kind: (e.url && !e.description && !e.title ? "link" : "embed") as ChatAttachment["kind"],
        name: e.title || e.url || "embed", url: e.url ?? undefined,
        text: e.description ? e.description.replace(/\s+/g, " ").slice(0, 300) : undefined,
      })),
      ...m.stickers.map(s => ({ name: s.name || "sticker", kind: "sticker" as const })),
    ];
    messages.push({
      messageId: m.id,
      authorId: m.author.id,
      authorName: m.author.nickname || m.author.name,
      sentAt,
      editedAt: Number.isNaN(edited) ? undefined : edited,
      text: m.content,
      replyToId: m.reference?.messageId ?? undefined,
      replyConversationId: m.reference?.channelId && m.reference.channelId!==channel.id ? m.reference.channelId : undefined,
      mentionedUserIds: m.mentions.length ? m.mentions.map(user => user.id) : undefined,
      reactedUserIds: m.reactions.some(reaction => reaction.users.length)
        ? [...new Set(m.reactions.flatMap(reaction => reaction.users.map(user => user.id)))] : undefined,
      attachments,
      reactions: m.reactions.length
        ? m.reactions.map(r => ({ emoji: r.emoji.name || r.emoji.code || "?", count: r.count })) : undefined,
      isBot: m.author.isBot ?? undefined,
      isSystem: SYSTEM_TYPES.has(m.type) || undefined,
    });
  }
  return { conversation, messages, skipped };
}
