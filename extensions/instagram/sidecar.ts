import { existsSync } from "node:fs";
import type { ShaleSDK } from "@shale/sdk";
import type { ChatConnector } from "@shale/sdk/chat/commit";
import type { ChatAttachment, ChatConversation, ChatMessage } from "@shale/sdk/chat/types";
import { participantMatchKey } from "./connector";
import { INSTAGRAM_DEFAULTS, type InstagramSettings } from "./settings.types";
import { SidecarProcess, sessionPath } from "./sidecar-process";
import { instagramCredentials } from "./auth";

const SINCE_KEY = "sync:since";

interface SidecarUser { pk: string; name: string; username?: string | null }
interface SidecarMessage {
  id: string; user_id: string; timestamp: number; text: string; item_type: string; reply_to_id?: string | null;
  attachments: Array<{ kind: ChatAttachment["kind"]; name: string; url?: string | null; text?: string | null }>;
  reactions: Array<{ emoji: string; count: number }>; is_system: boolean;
}
type SidecarLine =
  | { type: "thread"; thread: { id: string; title: string; is_group: boolean; users: SidecarUser[]; viewer: SidecarUser }; messages: SidecarMessage[] }
  | { type: "error"; code: string; message: string }
  | { type: "done"; threads: number };

/** Normalise one sidecar thread record; ids are `api:`-prefixed so cross-feed duplicates can be recognised. */
export function sidecarThread(line: Extract<SidecarLine, { type: "thread" }>) {
  const { thread } = line;
  const people = [thread.viewer, ...thread.users];
  const names = new Map(people.map(user => [user.pk, user.name]));
  const conversationId = `api:${thread.id}`;
  const conversation: ChatConversation = {
    conversationId, kind: thread.is_group || thread.users.length > 1 ? "group" : "dm",
    title: thread.title || thread.users.map(user => user.name).join(", ") || thread.id,
    uri: `instagram://thread/${encodeURIComponent(conversationId)}`, matchKey: participantMatchKey(people.map(user => user.name)),
  };
  const messages: ChatMessage[] = line.messages.map(m => ({
    messageId: `api:${m.id}`, authorId: m.user_id || "unknown", authorName: names.get(m.user_id) ?? m.user_id ?? "unknown",
    sentAt: m.timestamp, text: m.text ?? "", replyToId: m.reply_to_id ? `api:${m.reply_to_id}` : undefined,
    attachments: m.attachments.map(a => ({ kind: a.kind, name: a.name, url: a.url ?? undefined, text: a.text ?? undefined })),
    reactions: m.reactions.length ? m.reactions : undefined, isSystem: m.is_system || undefined,
  }));
  return { threadId: thread.id, conversation, messages };
}

export interface SidecarResult { threads: number; messages: number; errors: string[] }

/** Run the instagrapi sidecar and ingest its threads as they stream in. */
export async function syncInstagram(sdk: ShaleSDK, connector: ChatConnector, settings: InstagramSettings): Promise<SidecarResult> {
  const result: SidecarResult = { threads: 0, messages: 0, errors: [] };
  const { username, password } = instagramCredentials(sdk);
  if (!existsSync(sessionPath(settings)) && !(username && password)) {
    sdk.logger.warn("Instagram sync is enabled but no account is connected. Connect Instagram on the Accounts page of the Shale web interface. Skipping sync.");
    return result;
  }
  const since = sdk.state.getJson<Record<string, number>>(SINCE_KEY) ?? {};
  const child = new SidecarProcess(settings, [
    "--max-threads", String(settings.maxThreadsPerSync ?? INSTAGRAM_DEFAULTS.maxThreadsPerSync),
    "--max-messages", String(settings.maxMessagesPerThread ?? INSTAGRAM_DEFAULTS.maxMessagesPerThread),
  ], { IG_USERNAME: username, IG_PASSWORD: password });
  child.send({ since });
  child.close();
  const deadline = Date.now() + (settings.syncTimeoutMinutes ?? INSTAGRAM_DEFAULTS.syncTimeoutMinutes) * 60_000;
  try {
    for (;;) {
      const line = await child.next(Math.max(1, deadline - Date.now())) as SidecarLine | { type: "exit"; code: number | null; detail?: string };
      if (line.type === "exit") {
        if (line.code !== 0 && !result.errors.length) result.errors.push(`sidecar exited with ${line.code}${line.detail ? `: ${line.detail}` : ""}`);
        break;
      }
      if (line.type === "error") {
        result.errors.push(`${line.code}: ${line.message}`);
        sdk.logger.error(`Instagram sidecar: ${line.code}: ${line.message}`);
      } else if (line.type === "thread") {
        const { threadId, conversation, messages } = sidecarThread(line);
        const { changed } = connector.store.ingest(conversation, messages, { nearDuplicateMs: INSTAGRAM_DEFAULTS.nearDuplicateMs });
        // Advance per thread only after its messages committed.
        const newest = messages.reduce((max, m) => Math.max(max, m.sentAt), since[threadId] ?? 0);
        if (newest) { since[threadId] = newest; sdk.state.setJson(SINCE_KEY, since); }
        result.threads++;
        result.messages += changed;
      }
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    child.kill();
  }
  return result;
}
