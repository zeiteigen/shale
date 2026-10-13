import type { ShaleSDK } from "../extension-sdk";
import { withSourceRefresh } from "../../lib/memory/refresh-scope";
import { chatCheckpointId, commitWindow, prepareWindow, type ChatConnector } from "./commit";
import type { ChatWindowSettings } from "./types";

/**
 * Answer `source:refresh` for this connector's windows by re-summarising stored messages.
 * The handler is named after the platform because refresh requests target a source's origin.
 */
export function setupChatRefresh(sdk: ShaleSDK, connector: () => ChatConnector, settings: () => ChatWindowSettings) {
  sdk.messages.handle("source:refresh", async request => {
    const source = sdk.context.getSource(request.sourceId);
    if (!source || source.origin !== connector().platform)
      return { sourceId: request.sourceId, status: "unavailable", reason: `Source is not owned by ${connector().platform}` };
    return withSourceRefresh({ sourceId: source.id, uri: source.uri, topic: request.topic }, async () => {
      try {
        const current = connector();
        const row = current.store.windowBySource(source.id);
        const conversation = row && current.store.conversation(row.conversation_id);
        const messages = row ? current.store.messagesBetween(row.conversation_id, row.start_time, row.end_time) : [];
        if (!row || !conversation || !messages.length)
          return { sourceId: source.id, status: "unavailable", reason: "The stored messages for this window are gone" };
        sdk.checkpoint.delete(chatCheckpointId(row.window_id));
        const prepared = await prepareWindow(sdk, current, { windowId: row.window_id, conversation, messages,
          startTime: row.start_time, endTime: row.end_time, messageHash: row.message_hash }, settings());
        if (!prepared) return { sourceId: source.id, status: "unavailable", reason: "The window has no indexable messages" };
        commitWindow(sdk, current, prepared.id, prepared.data);
        return { sourceId: source.id, status: "refreshed", memoryVersion: sdk.memory.get(source.id).version };
      } catch (error) {
        return { sourceId: source.id, status: "unavailable", reason: String(error).slice(0, 300) };
      }
    });
  }, { name: connector().platform });
}
