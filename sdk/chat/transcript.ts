import type { ChatAttachment, ChatWindowMessage } from "./types";

const CHUNK_CHARS = 1200;

const pad = (n: number) => String(n).padStart(2, "0");
const day = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

function attachmentText(attachment: ChatAttachment): string {
  const body = [attachment.name, attachment.text].filter(Boolean).join(" — ");
  return `[${attachment.kind}: ${body}${attachment.kind === "link" && attachment.url && !body.includes(attachment.url) ? ` ${attachment.url}` : ""}]`;
}

/** One transcript line per message: `[HH:MM] Name: text [image: a.png] {👍×2}`. */
export function transcriptLine(message: ChatWindowMessage, byId: Map<string, ChatWindowMessage>): string {
  const date = new Date(message.sentAt);
  const reply = message.replyToId ? byId.get(message.replyToId) : undefined;
  const parts = [`[${pad(date.getHours())}:${pad(date.getMinutes())}] ${message.authorName}`];
  if (message.replyToId) parts[0] += reply ? ` (↪ ${reply.authorName})` : " (↪ reply)";
  if (message.editedAt) parts[0] += " (edited)";
  parts[0] += ":";
  if (message.text.trim()) parts.push(message.text.trim());
  for (const attachment of message.attachments) parts.push(attachmentText(attachment));
  if (message.reactions?.length) parts.push(`{${message.reactions.map(r => `${r.emoji}×${r.count}`).join(" ")}}`);
  return parts.join(" ");
}

export function transcriptLines(messages: ChatWindowMessage[]): string[] {
  const byId = new Map(messages.map(message => [message.messageId, message]));
  const lines: string[] = [];
  let currentDay = "";
  for (const message of messages) {
    if (message.isSystem) continue;
    const today = day(new Date(message.sentAt));
    if (today !== currentDay) lines.push(`— ${currentDay = today} —`);
    lines.push(transcriptLine(message, byId));
  }
  return lines;
}

function splitLong(line: string, size: number): string[] {
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > size) {
    let cut = rest.lastIndexOf(" ", size);
    const sentence = Math.max(rest.lastIndexOf(". ", size), rest.lastIndexOf("\n", size));
    if (sentence > size / 2) cut = sentence + 1;
    if (cut < size / 2) cut = size;
    if (/[\uD800-\uDBFF]/.test(rest[cut - 1] ?? "")) cut--;
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** Pack lines into verbatim chunks that fit one memory snippet, never splitting a short line. */
export function transcriptChunks(messages: ChatWindowMessage[], size = CHUNK_CHARS) {
  const chunks: string[] = [];
  let current = "";
  for (const line of transcriptLines(messages).flatMap(line => splitLong(line, size))) {
    if (current && current.length + 1 + line.length > size) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  return chunks.map((text_content, chunk_index) => ({ text_content, chunk_index, chunk_type: "verbatim" as const }));
}
