import type { ShaleSDK } from "../extension-sdk";
import type { CheckpointContext } from "../types";
import { SourceGraph } from "../graph/source";
import { acquireTaskLease } from "../../lib/task-lease";
import { contentFingerprint, memoryChunks, prepareSourceMemory } from "../../lib/memory/prepare";
import type { ChatStore } from "./store";
import { summarizeWindow } from "./summarize";
import { transcriptChunks } from "./transcript";
import { pendingWindows } from "./windows";
import type { ChatParticipant, ChatWindow, ChatWindowSettings, PreparedChatWindow } from "./types";
import { chatHash } from "./store";
import { conversationHash } from "./conversation-hash";

export const CHAT_SOURCE_TYPE = "chat_session";

export interface ChatConnector {
  /** Platform name; also the source origin and the external-id authority, e.g. "discord". */
  platform: string;
  namespace: string;
  store: ChatStore;
}

export const chatCheckpointId = (windowId: string) => `chat_window:${windowId}`;

export function windowUri(conversationUri: string, firstMessageId: string) {
  return `${conversationUri}#window=${encodeURIComponent(firstMessageId)}`;
}

function participants(window: ChatWindow): PreparedChatWindow["participants"] {
  const byId = new Map<string, ChatParticipant & { messages: number }>();
  for (const message of window.messages) {
    if (message.isSystem) continue;
    const entry = byId.get(message.authorId) ?? {
      id: message.authorId, name: message.authorName, isBot: message.isBot, messages: 0,
      externalId: message.authorId.startsWith("name:") ? undefined : message.authorId,
    };
    entry.name = message.authorName || entry.name;
    entry.messages++;
    byId.set(message.authorId, entry);
  }
  return [...byId.values()];
}

/** Summarise and checkpoint one window. Returns null when nothing in it is worth indexing. */
export async function prepareWindow(sdk: ShaleSDK, connector: ChatConnector, window: ChatWindow,
  settings: ChatWindowSettings): Promise<{ id: string; data: PreparedChatWindow } | null> {
  const id = chatCheckpointId(window.windowId);
  const cached = sdk.checkpoint.get<PreparedChatWindow>(id);
  if (cached?.data.type === "chat_window" && cached.data.messageHash === window.messageHash) return { id, data: cached.data };
  const messages = window.messages.filter(message => !(settings.excludeBots && message.isBot));
  const chunks = transcriptChunks(messages);
  if (!chunks.length) {
    connector.store.markIndexed(window.windowId, window.conversation.conversationId, window.startTime, window.endTime,
      window.messageHash, null);
    return null;
  }
  const transcript = chunks.map(chunk => chunk.text_content).join("\n");
  const synthesis = await summarizeWindow(sdk, window.conversation, messages, transcript,
    { enabled: settings.summarize !== false, model: settings.llmModel });
  const memory = prepareSourceMemory(chunks, { title: synthesis.title, summary: synthesis.summary });
  const data: PreparedChatWindow = {
    type: "chat_window", platform: connector.platform, namespace: connector.namespace, windowId: window.windowId,
    conversation: window.conversation, startTime: window.startTime, endTime: window.endTime,
    messageCount: messages.filter(message => !message.isSystem).length, messageHash: window.messageHash,
    firstMessageId: window.messages[0]!.messageId, participants: participants({ ...window, messages }),
    synthesis, sourceHash: chatHash([conversationHash(window.conversation), contentFingerprint(chunks)]), memory,
  };
  sdk.saveCheckpoint(data, { id, key: id });
  return { id, data };
}

function commitGraph(sdk: ShaleSDK, sourceId: string, uri: string, data: PreparedChatWindow) {
  const { conversation, synthesis, platform } = data;
  const graph = new SourceGraph(sdk.database, sdk.graph, sourceId, data.namespace, data.endTime);
  const session = graph.entity(uri, synthesis.title, "ChatSession");
  graph.claim(session, "SOURCE_URI", { value: uri });
  const venue = graph.entity(conversation.uri, conversation.title, "Conversation");
  graph.claim(venue, "PLATFORM", { value: platform });
  graph.link(session, "IN_CONVERSATION", venue);
  if (conversation.server) graph.link(venue, "PART_OF", graph.entity(conversation.server.uri, conversation.server.name, "Server"));
  const people = data.participants.map(participant => {
    const person = graph.entity(`${platform}:user:${participant.id}`, participant.name, participant.isBot ? "Bot" : "Person");
    if (participant.externalId) {
      try {
        sdk.graph.entities.addAlias(person, participant.externalId, `external:${platform}`);
      } catch (error) {
        sdk.logger.warn(`Skipped ${platform} id alias for ${participant.name}:`, error);
      }
    }
    graph.link(person, "PARTICIPATED_IN", venue, { qualifiers: { lastSeenAt: data.endTime } });
    return person;
  });
  const interpretation = {
    status: "proposed" as const, method: synthesis.method, model: synthesis.model,
    evidence: graph.evidence(0, undefined, "generated", "mentions"),
  };
  graph.claim(session, "SUMMARY", { value: synthesis.summary }, interpretation);
  for (const topic of synthesis.topics)
    graph.link(session, "COVERS_TOPIC", graph.entity(topic.toLocaleLowerCase(), topic, "Topic", topic), interpretation);
  graph.event(`chat:${data.windowId}`, {
    name: synthesis.title, kind: "conversation", occurredFrom: data.startTime, occurredTo: data.endTime,
    participants: [
      { entity: session, role: "record" },
      { entity: venue, role: "venue" },
      ...people.map((entity, position) => ({ entity, role: "participant", position })),
    ],
  });
}

/** Source, graph, window state, superseded windows, and checkpoint removal commit together. */
export function commitWindow(sdk: ShaleSDK, connector: ChatConnector, id: string, data: PreparedChatWindow) {
  const { store } = connector;
  const uri = windowUri(data.conversation.uri, data.firstMessageId);
  return sdk.database.transaction(() => {
    const result = sdk.ingest.sourceAndChunks({
      namespace: data.namespace,
      source: { id: `${data.platform}-window:${data.windowId}`, type: CHAT_SOURCE_TYPE, uri, origin: data.platform,
        title: data.synthesis.title, created_at: data.startTime, updated_at: data.endTime, hash: data.sourceHash },
      chunks: memoryChunks(data.memory),
      memory: data.memory,
    });
    if (!result.skipped) commitGraph(sdk, result.sourceId, uri, data);
    // Backfilled or re-cut history can replace windows that covered the same span.
    for (const stale of store.overlappingWindows(data.conversation.conversationId, data.startTime, data.endTime, data.windowId)) {
      if (stale.source_id && stale.source_id !== result.sourceId)
        sdk.database.query("DELETE FROM sources WHERE id=?").run(stale.source_id);
      store.deleteWindow(stale.window_id);
    }
    store.markIndexed(data.windowId, data.conversation.conversationId, data.startTime, data.endTime, data.messageHash,
      result.skipped ? null : result.sourceId);
    sdk.checkpoint.delete(id);
    return { ...result, uri };
  })();
}

export async function finalizeWindows(sdk: ShaleSDK, connector: ChatConnector,
  prepared: Array<{ id: string; data: PreparedChatWindow }>) {
  let indexed = 0;
  const errors: string[] = [];
  for (const { id, data } of prepared) {
    try {
      const current = connector.store.conversation(data.conversation.conversationId);
      if (current && conversationHash(current) !== conversationHash(data.conversation)) {
        // A renamed conversation must be prepared again instead of restoring an old summary.
        sdk.checkpoint.delete(id);
        continue;
      }
      const result = commitWindow(sdk, connector, id, data);
      if (result.skipped) continue;
      indexed++;
      try {
        await sdk.messages.publish("source:ingested", { sourceId: result.sourceId, type: CHAT_SOURCE_TYPE, uri: result.uri,
          title: data.synthesis.title, origin: data.platform, namespace: data.namespace, chunksCount: result.chunksCount,
          timestamp: Date.now() });
      } catch (error) {
        sdk.logger.warn(`Window committed but source:ingested notification failed for ${result.uri}:`, error);
      }
    } catch (error) {
      connector.store.markFailed(data.windowId, error);
      errors.push(`${data.conversation.title}: ${error instanceof Error ? error.message : String(error)}`);
      sdk.logger.error(`Failed to commit chat window ${data.windowId}:`, error);
    }
  }
  return { indexed, errors };
}

/** Hold a persistent lease so a cron run and checkpoint recovery never overlap. */
export async function withChatLease<T>(sdk: ShaleSDK, work: () => Promise<T>): Promise<T | null> {
  const lease = acquireTaskLease(sdk.database, sdk.extensionId, "chat-index-lease", 600_000);
  if (!lease) {
    sdk.logger.log("Another run of this connector is in progress; skipping.");
    return null;
  }
  const timer = setInterval(() => { try { lease.renew(); } catch { /* reported by the next renew */ } }, 60_000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
    lease.release();
  }
}

/** Index every sealed, changed window: summaries are prepared in a model batch, then committed. */
export async function indexChatWindows(sdk: ShaleSDK, connector: ChatConnector, settings: ChatWindowSettings) {
  const totals = { windows: 0, indexed: 0, errors: [] as string[] };
  for (;;) {
    const windows = pendingWindows(connector.store, connector.platform, settings);
    if (!windows.length) break;
    totals.windows += windows.length;
    const result = await sdk.models.batch(
      async () => (await sdk.models.mapChat(windows, async window => {
        try {
          return await prepareWindow(sdk, connector, window, settings);
        } catch (error) {
          connector.store.markFailed(window.windowId, error);
          totals.errors.push(`${window.conversation.title}: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      })).filter(item => item !== null),
      prepared => finalizeWindows(sdk, connector, prepared),
    );
    totals.indexed += result.indexed;
    totals.errors.push(...result.errors);
    if (windows.length < (settings.maxWindowsPerRun ?? 50)) break;
  }
  return totals;
}

/** Commit queued window checkpoints without calling the LLM again. */
export async function recoverChatWindows(sdk: ShaleSDK, connector: ChatConnector, context: CheckpointContext<PreparedChatWindow>) {
  const prepared = context.checkpoints
    .filter(checkpoint => checkpoint.data?.type === "chat_window" && checkpoint.data.platform === connector.platform)
    .map(checkpoint => ({ id: checkpoint.id, data: checkpoint.data }));
  const result = await finalizeWindows(sdk, connector, prepared);
  if (result.errors.length) throw new Error(`Chat window recovery failed for ${result.errors.length} window(s)`);
  return { recoveredWindows: result.indexed };
}
