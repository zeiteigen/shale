import { chatHash } from "./hash";
import type { ChatConversation } from "./types";

/** Only metadata used in summaries, source URIs, and graph projections invalidates windows. */
export function conversationHash(conversation: ChatConversation): string {
  const { title, kind, uri, server } = conversation;
  return chatHash([title, kind, uri, server?.id, server?.name, server?.uri]);
}
