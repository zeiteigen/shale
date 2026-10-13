/**
 * Durable admission for snapshots sent by the Chrome extension's ai-chats module
 * (`target_processor: "ai-chats"`), plus its `/connectors/ai-chats/{policy,status,retry}` endpoints.
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { getSDK, type ShaleSDK } from "@shale/sdk";
import type { IngestMaterial } from "../../lib/ingest.types";
import {
  AI_CHATS_PROTOCOL_VERSION, AiChatProtocolError, MAX_AI_CHAT_BYTES, MAX_AI_CHAT_RECORDS, validateAiChatBatch,
  type AiChatSnapshot,
} from "./contract";
import { aiChatConnector, aiChatsSettings, enabledProviders } from "./connector";
import { applySnapshot } from "./ingest";
import { AI_CHATS_DEFAULTS } from "./settings.types";

let cachedSdk: ShaleSDK | null = null;
const resolveSDK = () => (cachedSdk ??= getSDK(import.meta.dir));

type ReceiptStatus = "received" | "duplicate" | "skipped";
interface ReceiptRow { job_id: string; hash: string; status: ReceiptStatus; reason: string | null }

function receipts(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS ai_chat_receipts (
    collector_id TEXT NOT NULL, record_id TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE, hash TEXT NOT NULL,
    status TEXT NOT NULL, reason TEXT, received_at INTEGER NOT NULL,
    PRIMARY KEY(collector_id, record_id)
  ) STRICT`);
  return db;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function capturePolicy(sdk: ShaleSDK) {
  const settings = aiChatsSettings(sdk);
  return {
    protocolVersion: AI_CHATS_PROTOCOL_VERSION,
    providers: enabledProviders(settings),
    autoSyncMinutes: settings.autoSyncMinutes ?? AI_CHATS_DEFAULTS.autoSyncMinutes,
    fetchDelayMs: settings.fetchDelayMs ?? AI_CHATS_DEFAULTS.fetchDelayMs,
    maxConversationsPerSync: settings.maxConversationsPerSync ?? AI_CHATS_DEFAULTS.maxConversationsPerSync,
  };
}

function admit(sdk: ShaleSDK, collectorId: string, record: AiChatSnapshot) {
  const db = receipts(sdk.database);
  const hash = sha256(JSON.stringify(record));
  const jobId = `ai-chat-job:${sha256(JSON.stringify([collectorId, record.recordId]))}`;
  const existing = db.query<ReceiptRow, [string, string]>(
    "SELECT job_id,hash,status,reason FROM ai_chat_receipts WHERE collector_id=? AND record_id=?").get(collectorId, record.recordId);
  if (existing) {
    if (existing.hash !== hash) throw new AiChatProtocolError(`Record ${record.recordId} was reused with different content`, 409);
    return { recordId: record.recordId, jobId: existing.job_id, status: "duplicate" as const };
  }
  const settings = aiChatsSettings(sdk);
  let status: ReceiptStatus = "skipped", reason: string | undefined;
  if (!enabledProviders(settings).includes(record.provider)) reason = `${record.provider} capture is turned off in ai-chats settings`;
  else ({ status, reason } = applySnapshot(sdk, aiChatConnector(sdk, record.provider, settings), settings, record));
  db.query("INSERT INTO ai_chat_receipts(collector_id,record_id,job_id,hash,status,reason,received_at) VALUES(?,?,?,?,?,?,?)")
    .run(collectorId, record.recordId, jobId, hash, status, reason ?? null, Date.now());
  return { recordId: record.recordId, jobId, status, ...(reason ? { reason } : {}) };
}

export async function accept(item: IngestMaterial, sdkOverride?: ShaleSDK) {
  const sdk = sdkOverride ?? resolveSDK();
  let payload: unknown;
  try {
    payload = JSON.parse(item.content);
  } catch {
    throw new AiChatProtocolError("Invalid AI chat JSON");
  }
  const batch = validateAiChatBatch(payload);
  // Each record commits with its receipt; a retried batch then sees the earlier ones as duplicates.
  const records = batch.records.map(record =>
    sdk.database.transaction(() => admit(sdk, batch.collectorId, record))());
  return { protocolVersion: AI_CHATS_PROTOCOL_VERSION, collectorId: batch.collectorId, batchId: batch.batchId, records };
}

export async function subscribe(item: IngestMaterial, sdkOverride?: ShaleSDK): Promise<void> {
  await accept(item, sdkOverride);
}

export function capabilities() {
  return { protocolVersions: [AI_CHATS_PROTOCOL_VERSION], maxBytes: MAX_AI_CHAT_BYTES, maxRecords: MAX_AI_CHAT_RECORDS };
}

/** Stored messages are the commit point, so every admitted record is already terminal. */
function status(sdk: ShaleSDK, ids: string[]) {
  const db = receipts(sdk.database);
  const rows = db.query<ReceiptRow, [string]>(
    "SELECT job_id,hash,status,reason FROM ai_chat_receipts WHERE job_id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(ids));
  return {
    protocolVersion: AI_CHATS_PROTOCOL_VERSION,
    records: rows.map(row => ({
      jobId: row.job_id, status: row.status === "skipped" ? "skipped" : "indexed", ...(row.reason ? { reason: row.reason } : {}),
    })),
  };
}

export async function inspect(req: Request, sdkOverride?: ShaleSDK): Promise<Response> {
  const sdk = sdkOverride ?? resolveSDK();
  const url = new URL(req.url), endpoint = url.pathname.split("/").at(-1);
  try {
    if (req.method === "GET" && endpoint === "policy") return Response.json(capturePolicy(sdk));
    if (req.method === "GET" && endpoint === "status") {
      const ids = url.searchParams.get("ids")?.split(",").filter(Boolean) ?? [];
      if (ids.length > 100 || ids.some(id => id.length > 200)) throw new Error("Invalid receipt IDs");
      return Response.json(status(sdk, ids));
    }
    // Admission already applied the record, so there is nothing to re-run.
    if (req.method === "POST" && endpoint === "retry") return Response.json({ success: true });
    return Response.json({ error: "Unknown ai-chats endpoint or method" }, { status: 404 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}

export default subscribe;
