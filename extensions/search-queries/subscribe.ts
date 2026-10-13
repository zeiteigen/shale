/**
 * Durable admission for searches sent by the Chrome extension's search-queries module
 * (`target_processor: "search-queries"`), plus its `/connectors/search-queries/{policy,status,retry}` endpoints.
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { getSDK, type ShaleSDK } from "@shale/sdk";
import type { IngestMaterial } from "../../lib/ingest.types";
import {
  MAX_SEARCH_BYTES, MAX_SEARCH_RECORDS, SEARCH_PROTOCOL_VERSION, SearchProtocolError, validateSearchBatch, type SearchRecord,
} from "./contract";
import { enabledEngines, searchSettings } from "./settings";
import { recordSearch, recordVisit, searchTables } from "./store";
import { SEARCH_QUERIES_DEFAULTS } from "./settings.types";

let cachedSdk: ShaleSDK | null = null;
const resolveSDK = () => (cachedSdk ??= getSDK(import.meta.dir));

type ReceiptStatus = "received" | "duplicate" | "skipped";
interface ReceiptRow { job_id: string; hash: string; status: ReceiptStatus; reason: string | null }

function receipts(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS search_query_receipts (
    collector_id TEXT NOT NULL, record_id TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE, hash TEXT NOT NULL,
    status TEXT NOT NULL, reason TEXT, received_at INTEGER NOT NULL,
    PRIMARY KEY(collector_id, record_id)
  ) STRICT`);
  return db;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function capturePolicy(sdk: ShaleSDK) {
  const settings = searchSettings(sdk);
  return {
    protocolVersion: SEARCH_PROTOCOL_VERSION,
    engines: enabledEngines(settings),
    captureAiOverview: settings.captureAiOverview ?? SEARCH_QUERIES_DEFAULTS.captureAiOverview,
  };
}

function admit(sdk: ShaleSDK, collectorId: string, record: SearchRecord) {
  const db = receipts(searchTables(sdk.database));
  const hash = sha256(JSON.stringify(record));
  const jobId = `search-job:${sha256(JSON.stringify([collectorId, record.recordId]))}`;
  const existing = db.query<ReceiptRow, [string, string]>(
    "SELECT job_id,hash,status,reason FROM search_query_receipts WHERE collector_id=? AND record_id=?").get(collectorId, record.recordId);
  if (existing) {
    if (existing.hash !== hash) throw new SearchProtocolError(`Record ${record.recordId} was reused with different content`, 409);
    return { recordId: record.recordId, jobId: existing.job_id, status: "duplicate" as const };
  }
  const settings = searchSettings(sdk);
  let status: ReceiptStatus = "skipped", reason: string | undefined;
  if (!enabledEngines(settings).includes(record.engine)) reason = `${record.engine} capture is turned off in search-queries settings`;
  else {
    if (record.type === "search_query")
      recordSearch(db, record, settings.captureAiOverview ?? SEARCH_QUERIES_DEFAULTS.captureAiOverview);
    else recordVisit(db, record);
    status = "received";
  }
  db.query("INSERT INTO search_query_receipts(collector_id,record_id,job_id,hash,status,reason,received_at) VALUES(?,?,?,?,?,?,?)")
    .run(collectorId, record.recordId, jobId, hash, status, reason ?? null, Date.now());
  return { recordId: record.recordId, jobId, status, ...(reason ? { reason } : {}) };
}

export async function accept(item: IngestMaterial, sdkOverride?: ShaleSDK) {
  const sdk = sdkOverride ?? resolveSDK();
  let payload: unknown;
  try {
    payload = JSON.parse(item.content);
  } catch {
    throw new SearchProtocolError("Invalid search JSON");
  }
  const batch = validateSearchBatch(payload);
  // Each record commits with its receipt; a retried batch then sees the earlier ones as duplicates.
  const records = batch.records.map(record =>
    sdk.database.transaction(() => admit(sdk, batch.collectorId, record))());
  return { protocolVersion: SEARCH_PROTOCOL_VERSION, collectorId: batch.collectorId, batchId: batch.batchId, records };
}

export async function subscribe(item: IngestMaterial, sdkOverride?: ShaleSDK): Promise<void> {
  await accept(item, sdkOverride);
}

export function capabilities() {
  return { protocolVersions: [SEARCH_PROTOCOL_VERSION], maxBytes: MAX_SEARCH_BYTES, maxRecords: MAX_SEARCH_RECORDS };
}

/** The raw search log is the commit point, so every admitted record is already terminal. */
function status(sdk: ShaleSDK, ids: string[]) {
  const db = receipts(sdk.database);
  const rows = db.query<ReceiptRow, [string]>(
    "SELECT job_id,hash,status,reason FROM search_query_receipts WHERE job_id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(ids));
  return {
    protocolVersion: SEARCH_PROTOCOL_VERSION,
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
    return Response.json({ error: "Unknown search-queries endpoint or method" }, { status: 404 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}

export default subscribe;
