/** Private connector input and resumable processing state; scoped readers see the sources only. */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { MAX_TRANSCRIPT_CHARACTERS, YoutubeProtocolError, transcriptContent, type SubtitleRecord, type SubtitleTrack, type VideoMetadata, type VideoRecord } from "./contract";
import { mergeRanges, type PlayedRange } from "./progress";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export interface VideoRow {
  video_id: string; metadata: string; metadata_at: number; first_watched_at: number; last_watched_at: number;
  ranges: string; version: number; dirty: number; retry_after: number; error: string | null;
  source_id: string | null; indexed_version: number; indexed_transcript: string | null; indexed_key: string | null; excluded: number;
}
export interface TranscriptRow {
  video_id: string; transcript_id: string; language: string; generated: number; captured_at: number;
  part_count: number; complete: number; cues: string | null;
}
export const metadataOf = (row: VideoRow): VideoMetadata => JSON.parse(row.metadata);
export const rangesOf = (row: VideoRow): PlayedRange[] => JSON.parse(row.ranges);
export const trackOf = (row: TranscriptRow): SubtitleTrack => ({ language: row.language, generated: !!row.generated, cues: JSON.parse(row.cues!) });

export function youtubeTables(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS youtube_videos (
    video_id TEXT PRIMARY KEY, metadata TEXT NOT NULL, metadata_at INTEGER NOT NULL,
    first_watched_at INTEGER NOT NULL, last_watched_at INTEGER NOT NULL, ranges TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, dirty INTEGER NOT NULL DEFAULT 1, retry_after INTEGER NOT NULL DEFAULT 0,
    error TEXT, source_id TEXT, indexed_version INTEGER NOT NULL DEFAULT 0, indexed_transcript TEXT,
    indexed_key TEXT, excluded INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE INDEX IF NOT EXISTS youtube_dirty ON youtube_videos(retry_after) WHERE dirty=1;
  CREATE TABLE IF NOT EXISTS youtube_transcripts (
    video_id TEXT NOT NULL, transcript_id TEXT NOT NULL, language TEXT NOT NULL, generated INTEGER NOT NULL,
    captured_at INTEGER NOT NULL, part_count INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0, cues TEXT,
    PRIMARY KEY(video_id,transcript_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS youtube_transcript_parts (
    video_id TEXT NOT NULL, transcript_id TEXT NOT NULL, part_index INTEGER NOT NULL, cues TEXT NOT NULL,
    PRIMARY KEY(video_id,transcript_id,part_index)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS youtube_receipts (
    collector_id TEXT NOT NULL, record_id TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE, hash TEXT NOT NULL,
    video_id TEXT NOT NULL, transcript_id TEXT, version INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT,
    PRIMARY KEY(collector_id,record_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS youtube_summary_cache (cache_key TEXT PRIMARY KEY,result TEXT NOT NULL) STRICT;`);
  return db;
}

export const videoFor = (db: Database, id: string) => db.query<VideoRow, [string]>("SELECT * FROM youtube_videos WHERE video_id=?").get(id);
export const transcriptFor = (db: Database, id: string) => db.query<TranscriptRow, [string]>(
  "SELECT * FROM youtube_transcripts WHERE video_id=? AND complete=1 ORDER BY captured_at DESC,transcript_id DESC LIMIT 1").get(id);

export function recordVideo(db: Database, record: VideoRecord) {
  const previous = videoFor(db, record.videoId);
  // The newest metadata wins, while played ranges and first/last times only accumulate.
  const metadata = previous && previous.metadata_at > record.capturedAt ? metadataOf(previous) : record.metadata;
  const ranges = mergeRanges([...(previous ? rangesOf(previous) : []), ...record.ranges], metadata.duration);
  db.query(`INSERT INTO youtube_videos(video_id,metadata,metadata_at,first_watched_at,last_watched_at,ranges)
    VALUES(?,?,?,?,?,?) ON CONFLICT(video_id) DO UPDATE SET metadata=excluded.metadata,
    metadata_at=max(metadata_at,excluded.metadata_at), first_watched_at=min(first_watched_at,excluded.first_watched_at),
    last_watched_at=max(last_watched_at,excluded.last_watched_at), ranges=excluded.ranges,
    version=version+1,dirty=1,retry_after=0,error=NULL`)
    .run(record.videoId, JSON.stringify(metadata), record.capturedAt, record.firstWatchedAt, record.lastWatchedAt, JSON.stringify(ranges));
  return videoFor(db, record.videoId)!.version;
}

export function recordSubtitles(db: Database, record: SubtitleRecord) {
  const previous = db.query<TranscriptRow, [string, string]>("SELECT * FROM youtube_transcripts WHERE video_id=? AND transcript_id=?")
    .get(record.videoId, record.transcriptId);
  if (previous && (previous.language !== record.language || previous.generated !== Number(record.generated) || previous.part_count !== record.partCount))
    throw new YoutubeProtocolError("Conflicting transcript parts", 409);
  db.query(`INSERT INTO youtube_transcripts(video_id,transcript_id,language,generated,captured_at,part_count)
    VALUES(?,?,?,?,?,?) ON CONFLICT(video_id,transcript_id) DO UPDATE SET captured_at=max(captured_at,excluded.captured_at)`)
    .run(record.videoId, record.transcriptId, record.language, Number(record.generated), record.capturedAt, record.partCount);
  const cues = JSON.stringify(record.cues);
  const part = db.query<{ cues: string }, [string, string, number]>(
    "SELECT cues FROM youtube_transcript_parts WHERE video_id=? AND transcript_id=? AND part_index=?")
    .get(record.videoId, record.transcriptId, record.partIndex);
  if (part && part.cues !== cues) throw new YoutubeProtocolError("Conflicting transcript part content", 409);
  db.query("INSERT OR IGNORE INTO youtube_transcript_parts VALUES(?,?,?,?)").run(record.videoId, record.transcriptId, record.partIndex, cues);
  const parts = db.query<{ cues: string }, [string, string]>(
    "SELECT cues FROM youtube_transcript_parts WHERE video_id=? AND transcript_id=? ORDER BY part_index").all(record.videoId, record.transcriptId);
  const totalChars = parts.reduce((n, part) => n + JSON.parse(part.cues).reduce((s: number, cue: { text: string }) => s + cue.text.length, 0), 0);
  if (totalChars > MAX_TRANSCRIPT_CHARACTERS) throw new YoutubeProtocolError("Transcript is too large", 413);
  if (parts.length === record.partCount) {
    const track: SubtitleTrack = { language: record.language, generated: record.generated, cues: parts.flatMap(part => JSON.parse(part.cues)) };
    if (track.cues.some((cue, index) => index > 0 && cue.start < track.cues[index - 1]!.start))
      throw new YoutubeProtocolError("Transcript cues are out of order");
    if (digest(transcriptContent(record.videoId, track)) !== record.transcriptId) throw new YoutubeProtocolError("Transcript hash mismatch");
    db.query("UPDATE youtube_transcripts SET complete=1,cues=? WHERE video_id=? AND transcript_id=?")
      .run(JSON.stringify(track.cues), record.videoId, record.transcriptId);
    db.query("UPDATE youtube_videos SET version=version+1,dirty=1,retry_after=0,error=NULL WHERE video_id=?").run(record.videoId);
  }
  return videoFor(db, record.videoId)?.version ?? 0;
}

export const dueVideos = (db: Database, now: number, limit: number) => db.query<VideoRow, [number, number]>(
  "SELECT * FROM youtube_videos WHERE dirty=1 AND retry_after<=? ORDER BY retry_after,last_watched_at LIMIT ?").all(now, limit);

export function cached<T>(db: Database, key: string | null): T | undefined {
  if (!key) return;
  const row = db.query<{ result: string }, [string]>("SELECT result FROM youtube_summary_cache WHERE cache_key=?").get(key);
  return row ? JSON.parse(row.result) : undefined;
}
export const cache = (db: Database, key: string, value: unknown) => db.query("INSERT OR REPLACE INTO youtube_summary_cache VALUES(?,?)").run(key, JSON.stringify(value));
