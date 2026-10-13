/**
 * Wire contract between the Chrome module (chrome/) and the server (subscribe.ts).
 * Shared by both sides: the Chrome bundle validates before queueing, the server on admission.
 */
export const AI_CHATS_PROTOCOL_VERSION = 1;
export const MAX_AI_CHAT_BYTES = 2_000_000;
export const MAX_AI_CHAT_RECORDS = 100;
/** Each record stays well inside one delivery batch (the Chrome core batches up to 500 KB). */
export const MAX_SNAPSHOT_BYTES = 400_000;
export const MAX_MESSAGE_CHARS = 200_000;

export const PROVIDERS = {
  chatgpt: { label: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com"] },
  claude: { label: "Claude", hosts: ["claude.ai"] },
  gemini: { label: "Gemini", hosts: ["gemini.google.com"] },
} as const;
export type Provider = keyof typeof PROVIDERS;
export const PROVIDER_IDS = Object.keys(PROVIDERS) as Provider[];

export interface AiChatAttachment {
  name: string;
  kind: "image" | "file" | "link";
  url?: string;
}

export interface AiChatMessage {
  /** Provider message id, or a stable DOM-derived id for page captures. */
  id: string;
  role: "user" | "assistant";
  /** Epoch ms; omitted when the page shows no time (the server then keeps or infers one). */
  sentAt?: number;
  text: string;
  attachments: AiChatAttachment[];
}

/** One conversation as the user currently sees it (the active branch only). */
export interface NormalizedConversation {
  provider: Provider;
  conversationId: string;
  title: string;
  url: string;
  createdAt?: number;
  updatedAt?: number;
  /**
   * Ids of the complete active branch, in order. Present only when the capture saw the whole
   * conversation (API captures), so the server may drop messages from abandoned branches.
   */
  pathIds?: string[];
  messages: AiChatMessage[];
}

export interface AiChatSnapshot extends Omit<NormalizedConversation, "messages"> {
  type: "ai_chat_snapshot";
  recordId: string;
  captureMethod: "api" | "dom";
  /** Orders captures of one conversation; an older revision never overwrites a newer one. */
  revision: number;
  part: number;
  parts: number;
  messages: AiChatMessage[];
}

export interface AiChatBatch {
  type: "ai_chat_batch";
  protocolVersion: number;
  collectorId: string;
  batchId: string;
  records: AiChatSnapshot[];
}

export class AiChatProtocolError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
function fail(path: string): never {
  throw new AiChatProtocolError(`Invalid AI chat field: ${path}`);
}
function string(v: unknown, path: string, max: number, required = true) {
  if (v === undefined && !required) return;
  if (typeof v !== "string" || v.length > max || (required && !v.trim())) fail(path);
}
function id(v: unknown, path: string) {
  if (typeof v !== "string" || !/^[\w.:@/+=-]{1,200}$/.test(v)) fail(path);
}
function time(v: unknown, path: string, required = false) {
  if (v === undefined && !required) return;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail(path);
}
function array(v: unknown, path: string, max: number, check: (item: any, path: string) => void) {
  if (!Array.isArray(v) || v.length > max) fail(path);
  v.forEach((item, i) => check(item, `${path}[${i}]`));
}

export function providerForUrl(value: string): Provider | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  return PROVIDER_IDS.find(provider =>
    PROVIDERS[provider].hosts.some(h => host === h || host.endsWith(`.${h}`)));
}

function attachment(v: unknown, path: string) {
  if (!object(v)) fail(path);
  string(v.name, `${path}.name`, 500);
  if (!["image", "file", "link"].includes(v.kind)) fail(`${path}.kind`);
  string(v.url, `${path}.url`, 4096, false);
}

function message(v: unknown, path: string) {
  if (!object(v)) fail(path);
  id(v.id, `${path}.id`);
  if (v.role !== "user" && v.role !== "assistant") fail(`${path}.role`);
  time(v.sentAt, `${path}.sentAt`);
  if (typeof v.text !== "string" || v.text.length > MAX_MESSAGE_CHARS) fail(`${path}.text`);
  array(v.attachments, `${path}.attachments`, 50, attachment);
}

export function validateSnapshot(v: unknown, path = "record"): asserts v is AiChatSnapshot {
  if (!object(v) || v.type !== "ai_chat_snapshot") fail(`${path}.type`);
  string(v.recordId, `${path}.recordId`, 300);
  if (!PROVIDER_IDS.includes(v.provider)) fail(`${path}.provider`);
  id(v.conversationId, `${path}.conversationId`);
  string(v.title, `${path}.title`, 1000, false);
  string(v.url, `${path}.url`, 4096);
  if (providerForUrl(v.url) !== v.provider) fail(`${path}.url`);
  time(v.createdAt, `${path}.createdAt`);
  time(v.updatedAt, `${path}.updatedAt`);
  time(v.revision, `${path}.revision`, true);
  if (v.captureMethod !== "api" && v.captureMethod !== "dom") fail(`${path}.captureMethod`);
  if (!Number.isSafeInteger(v.parts) || v.parts < 1 || v.parts > 1000) fail(`${path}.parts`);
  if (!Number.isSafeInteger(v.part) || v.part < 0 || v.part >= v.parts) fail(`${path}.part`);
  if (v.pathIds !== undefined) array(v.pathIds, `${path}.pathIds`, 20_000, id);
  array(v.messages, `${path}.messages`, 5000, message);
  if (new Set(v.messages.map((m: AiChatMessage) => m.id)).size !== v.messages.length) fail(`${path}.messages`);
}

export function validateAiChatBatch(v: unknown): AiChatBatch {
  if (!object(v) || v.type !== "ai_chat_batch") fail("type");
  if (v.protocolVersion !== AI_CHATS_PROTOCOL_VERSION)
    throw new AiChatProtocolError(`Unsupported AI chat protocol version ${v.protocolVersion}`, 409);
  if (new TextEncoder().encode(JSON.stringify(v)).length > MAX_AI_CHAT_BYTES)
    throw new AiChatProtocolError("AI chat batch is too large", 413);
  string(v.collectorId, "collectorId", 200);
  string(v.batchId, "batchId", 200);
  if (!Array.isArray(v.records) || !v.records.length || v.records.length > MAX_AI_CHAT_RECORDS) fail("records");
  v.records.forEach((record: unknown, i: number) => validateSnapshot(record, `records[${i}]`));
  if (new Set(v.records.map((r: AiChatSnapshot) => r.recordId)).size !== v.records.length) fail("records.recordId");
  return v as AiChatBatch;
}

const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Split a conversation into snapshot records of at most `maxBytes` each. Every part carries the
 * full `pathIds`, so parts may arrive in any order. Record ids hash the content: re-capturing an
 * unchanged conversation yields the same ids, which the outbox and server treat as duplicates.
 */
export async function snapshotRecords(conversation: NormalizedConversation,
  options: { captureMethod: "api" | "dom"; revision: number; maxBytes?: number }): Promise<AiChatSnapshot[]> {
  const maxBytes = options.maxBytes ?? MAX_SNAPSHOT_BYTES;
  const { messages, ...header } = conversation;
  const base = { ...header, type: "ai_chat_snapshot" as const, captureMethod: options.captureMethod, revision: options.revision };
  const overhead = bytes({ ...base, recordId: "x".repeat(300), part: 999, parts: 999, messages: [] });
  if (overhead > maxBytes) throw new Error("Conversation metadata exceeds the snapshot size limit");
  const groups: AiChatMessage[][] = [[]];
  let size = overhead;
  const truncate = (item: AiChatMessage, room: number) =>
    ({ ...item, text: `${item.text.slice(0, room)}\n…[truncated ${item.text.length - room} characters]` });
  for (const item of messages) {
    // A message larger than a record keeps its head, which is what the transcript shows first.
    let current = item.text.length > MAX_MESSAGE_CHARS ? truncate(item, MAX_MESSAGE_CHARS - 100) : item;
    if (overhead + bytes(current) > maxBytes)
      current = truncate(item, Math.max(1000, Math.floor((maxBytes - overhead - bytes({ ...item, text: "" })) / 3)));
    const added = bytes(current) + 1;
    if (groups.at(-1)!.length && size + added > maxBytes) {
      groups.push([]);
      size = overhead;
    }
    groups.at(-1)!.push(current);
    size += added;
  }
  return Promise.all(groups.map(async (group, part) => {
    const record = { ...base, part, parts: groups.length, messages: group };
    const hash = await sha256(JSON.stringify(record));
    return { ...record, recordId: `${conversation.provider}:${conversation.conversationId}:${hash.slice(0, 32)}` };
  }));
}
