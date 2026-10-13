import { getSDK, type ShaleSDK } from "@shale/sdk";
import type { IngestMaterial } from "../../lib/ingest.types";
import { MAX_YOUTUBE_BYTES, MAX_YOUTUBE_RECORDS, YOUTUBE_PROTOCOL_VERSION, YoutubeProtocolError, validateYoutubeBatch, type YoutubeRecord } from "./contract";
import { YOUTUBE_DEFAULTS, type YoutubeSettings } from "./settings.types";
import { digest, recordSubtitles, recordVideo, youtubeTables } from "./store";

let sdkInstance: ShaleSDK | undefined;
const resolveSDK = () => sdkInstance ??= getSDK(import.meta.dir);
export const settingsFor = (sdk: ShaleSDK) => ({ ...YOUTUBE_DEFAULTS, ...sdk.settings.getAll<YoutubeSettings>() });
export function capturePolicy(sdk: ShaleSDK) {
  const { enabled, captureSubtitles, preferredLanguages } = settingsFor(sdk);
  return { protocolVersion: YOUTUBE_PROTOCOL_VERSION, enabled, captureSubtitles, preferredLanguages, watchedFraction: 0.5 };
}

function admit(sdk: ShaleSDK, collectorId: string, record: YoutubeRecord) {
  const db = sdk.database, hash = digest(JSON.stringify(record));
  const previous = db.query<{ hash: string; job_id: string }, [string, string]>(
    "SELECT hash,job_id FROM youtube_receipts WHERE collector_id=? AND record_id=?").get(collectorId, record.recordId);
  if (previous) {
    if (hash !== previous.hash) throw new YoutubeProtocolError("Record ID reused with different content", 409);
    return { recordId: record.recordId, jobId: previous.job_id, status: "duplicate" as const };
  }
  const settings = settingsFor(sdk);
  const reason = !settings.enabled ? "YouTube capture is disabled" : record.type === "youtube_subtitles" && !settings.captureSubtitles
    ? "YouTube subtitle capture is disabled" : undefined;
  const version = reason ? 0 : record.type === "youtube_video" ? recordVideo(db, record) : recordSubtitles(db, record);
  const status = reason ? "skipped" as const : "received" as const;
  const jobId = `youtube-job:${digest(JSON.stringify([collectorId, record.recordId]))}`;
  db.query("INSERT INTO youtube_receipts VALUES(?,?,?,?,?,?,?,?,?)").run(collectorId, record.recordId, jobId, hash,
    record.videoId, record.type === "youtube_subtitles" ? record.transcriptId : null, version, status, reason ?? null);
  return { recordId: record.recordId, jobId, status, ...(reason ? { reason } : {}) };
}

export async function accept(item: IngestMaterial, sdkOverride?: ShaleSDK) {
  const sdk = sdkOverride ?? resolveSDK();
  let payload: unknown;
  try { payload = JSON.parse(item.content); } catch { throw new YoutubeProtocolError("Invalid YouTube JSON"); }
  const batch = validateYoutubeBatch(payload);
  youtubeTables(sdk.database);
  const records = batch.records.map(record => sdk.database.transaction(() => admit(sdk, batch.collectorId, record))());
  return { protocolVersion: YOUTUBE_PROTOCOL_VERSION, collectorId: batch.collectorId, batchId: batch.batchId, records };
}
export async function subscribe(item: IngestMaterial, sdkOverride?: ShaleSDK) { await accept(item, sdkOverride); }
export const capabilities = () => ({ protocolVersions: [YOUTUBE_PROTOCOL_VERSION], maxBytes: MAX_YOUTUBE_BYTES, maxRecords: MAX_YOUTUBE_RECORDS });

export async function inspect(req: Request, sdkOverride?: ShaleSDK) {
  const sdk = sdkOverride ?? resolveSDK(), url = new URL(req.url), endpoint = url.pathname.split("/").at(-1);
  youtubeTables(sdk.database);
  try {
    if (req.method === "GET" && endpoint === "policy") return Response.json(capturePolicy(sdk));
    if (req.method === "GET" && endpoint === "status") {
      const ids = url.searchParams.get("ids")?.split(",").filter(Boolean) ?? [];
      if (ids.length > 100 || ids.some(id => id.length > 200)) throw new YoutubeProtocolError("Invalid receipt IDs");
      const rows = sdk.database.query<{ job_id: string; status: string; reason: string | null; version: number;
        transcript_id: string | null; indexed_version: number | null; indexed_transcript: string | null; excluded: number | null;
        error: string | null; transcript_at: number | null; indexed_at: number | null }, [string]>(`
        SELECT r.*,v.indexed_version,v.indexed_transcript,v.excluded,v.error,t.captured_at AS transcript_at,it.captured_at AS indexed_at
        FROM youtube_receipts r LEFT JOIN youtube_videos v USING(video_id)
        LEFT JOIN youtube_transcripts t ON t.video_id=r.video_id AND t.transcript_id=r.transcript_id AND t.complete=1
        LEFT JOIN youtube_transcripts it ON it.video_id=r.video_id AND it.transcript_id=v.indexed_transcript
        WHERE r.job_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids));
      return Response.json({ protocolVersion: YOUTUBE_PROTOCOL_VERSION, records: rows.map(row => {
        const indexed = row.transcript_id ? row.transcript_at !== null && row.indexed_at !== null && row.indexed_at >= row.transcript_at
          : (row.indexed_version ?? 0) >= row.version;
        // Automatic retries remain pollable; a transient model failure is not a terminal receipt.
        const status = row.status === "skipped" || row.excluded ? "skipped" : indexed ? "indexed" : "queued";
        const reason = row.reason || (!indexed ? row.error : null);
        return { jobId: row.job_id, status, ...(reason ? { reason } : {}) };
      }) });
    }
    if (req.method === "POST" && endpoint === "retry") {
      sdk.database.run("UPDATE youtube_videos SET dirty=1,retry_after=0,error=NULL WHERE error IS NOT NULL");
      return Response.json({ success: true });
    }
    return Response.json({ error: "Unknown YouTube endpoint or method" }, { status: 404 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}
export default subscribe;
