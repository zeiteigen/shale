import type { PlayedRange } from "./progress";

export const YOUTUBE_PROTOCOL_VERSION = 1;
export const MAX_YOUTUBE_BYTES = 1_000_000;
export const MAX_YOUTUBE_RECORDS = 100;
export const MAX_TRANSCRIPT_CHARACTERS = 2_000_000;
export const MAX_CUES_PER_PART = 100;

export function videoAt(value: string | URL): string | undefined {
  try {
    const url = new URL(value);
    const id = url.searchParams.get("v");
    if (url.protocol === "https:" && ["youtube.com", "www.youtube.com"].includes(url.hostname)
      && url.pathname === "/watch" && id && /^[\w-]{11}$/.test(id)) return id;
  } catch {}
}

export const videoUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

export interface VideoMetadata {
  title: string;
  description: string;
  channel: { name: string; id?: string; url?: string };
  duration: number;
  publishedAt?: string;
  thumbnail?: string;
  tags?: string[];
  category?: string;
  viewCount?: number;
  likeCount?: number;
}

export interface SubtitleCue { start: number; end: number; text: string }
export interface SubtitleTrack { language: string; generated: boolean; cues: SubtitleCue[] }
export interface VideoRecord {
  type: "youtube_video";
  recordId: string;
  videoId: string;
  capturedAt: number;
  firstWatchedAt: number;
  lastWatchedAt: number;
  metadata: VideoMetadata;
  ranges: PlayedRange[];
}
export interface SubtitleRecord {
  type: "youtube_subtitles";
  recordId: string;
  videoId: string;
  capturedAt: number;
  transcriptId: string;
  language: string;
  generated: boolean;
  partIndex: number;
  partCount: number;
  cues: SubtitleCue[];
}
export type YoutubeRecord = VideoRecord | SubtitleRecord;
export interface YoutubeBatch {
  type: "youtube_batch"; protocolVersion: number; collectorId: string; batchId: string; records: YoutubeRecord[];
}
export class YoutubeProtocolError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
function fail(field: string): never { throw new YoutubeProtocolError(`Invalid YouTube field: ${field}`); }
function string(value: unknown, field: string, max: number, optional = false) {
  if (optional && value === undefined) return;
  if (typeof value !== "string" || value.length > max || (!optional && !value.trim())) fail(field);
}
function number(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) fail(field);
}
function time(value: unknown, field: string) {
  number(value, field);
  if (!Number.isSafeInteger(value)) fail(field);
}
function webUrl(value: unknown, field: string, optional = false) {
  if (optional && value === undefined) return;
  string(value, field, 4096);
  try { if (new URL(value as string).protocol !== "https:") fail(field); } catch { fail(field); }
}

export function validateYoutubeRecord(value: unknown): asserts value is YoutubeRecord {
  if (!object(value)) fail("record");
  string(value.recordId, "recordId", 200);
  if (typeof value.videoId !== "string" || !/^[\w-]{11}$/.test(value.videoId)) fail("videoId");
  time(value.capturedAt, "capturedAt");
  if (value.type === "youtube_video") {
    time(value.firstWatchedAt, "firstWatchedAt"); time(value.lastWatchedAt, "lastWatchedAt");
    if (value.firstWatchedAt > value.lastWatchedAt || value.lastWatchedAt > value.capturedAt) fail("watch times");
    const m = value.metadata;
    if (!object(m) || !object(m.channel)) fail("metadata");
    string(m.title, "title", 1000); string(m.description, "description", 5000, true);
    if (typeof m.description !== "string") fail("description");
    string(m.channel.name, "channel.name", 500); string(m.channel.id, "channel.id", 200, true);
    webUrl(m.channel.url, "channel.url", true); webUrl(m.thumbnail, "thumbnail", true);
    number(m.duration, "duration", 172800); if (!m.duration) fail("duration");
    string(m.publishedAt, "publishedAt", 100, true); string(m.category, "category", 200, true);
    for (const field of ["viewCount", "likeCount"]) if (m[field] !== undefined) number(m[field], field);
    if (m.tags !== undefined && (!Array.isArray(m.tags) || m.tags.length > 100
      || m.tags.some((tag: unknown) => typeof tag !== "string" || tag.length > 200))) fail("tags");
    if (!Array.isArray(value.ranges) || !value.ranges.length || value.ranges.length > 2048) fail("ranges");
    for (const range of value.ranges) {
      if (!Array.isArray(range) || range.length !== 2) fail("range");
      number(range[0], "range.start", m.duration); number(range[1], "range.end", m.duration);
      if (range[1] <= range[0]) fail("range.end");
    }
  } else if (value.type === "youtube_subtitles") {
    if (typeof value.transcriptId !== "string" || !/^[a-f0-9]{64}$/.test(value.transcriptId)) fail("transcriptId");
    string(value.language, "language", 50);
    if (typeof value.generated !== "boolean") fail("generated");
    if (!Number.isInteger(value.partCount) || value.partCount < 1 || value.partCount > 2000
      || !Number.isInteger(value.partIndex) || value.partIndex < 0 || value.partIndex >= value.partCount) fail("parts");
    if (!Array.isArray(value.cues) || !value.cues.length || value.cues.length > MAX_CUES_PER_PART) fail("cues");
    for (const cue of value.cues) {
      if (!object(cue)) fail("cue");
      number(cue.start, "cue.start", 172800); number(cue.end, "cue.end", 172800);
      if (cue.end <= cue.start) fail("cue.end");
      string(cue.text, "cue.text", 10000);
    }
  } else fail("type");
}

export function validateYoutubeBatch(value: unknown): YoutubeBatch {
  if (!object(value) || value.type !== "youtube_batch") fail("type");
  if (value.protocolVersion !== YOUTUBE_PROTOCOL_VERSION) throw new YoutubeProtocolError("Unsupported YouTube protocol version", 409);
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_YOUTUBE_BYTES) throw new YoutubeProtocolError("YouTube batch is too large", 413);
  string(value.collectorId, "collectorId", 200); string(value.batchId, "batchId", 200);
  if (!Array.isArray(value.records) || !value.records.length || value.records.length > MAX_YOUTUBE_RECORDS) fail("records");
  value.records.forEach(validateYoutubeRecord);
  if (new Set(value.records.map((record: YoutubeRecord) => record.recordId)).size !== value.records.length) fail("recordId");
  return value as YoutubeBatch;
}

export const transcriptContent = (videoId: string, track: SubtitleTrack) => JSON.stringify([videoId, track.language, track.generated, track.cues]);
export async function sha256(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function subtitleRecords(videoId: string, track: SubtitleTrack, capturedAt: number): Promise<SubtitleRecord[]> {
  if (!track.cues.length || track.cues.reduce((n, cue) => n + cue.text.length, 0) > MAX_TRANSCRIPT_CHARACTERS)
    throw new YoutubeProtocolError("Transcript is empty or exceeds the supported size");
  const transcriptId = await sha256(transcriptContent(videoId, track));
  const parts: SubtitleCue[][] = [];
  let part: SubtitleCue[] = [], chars = 0;
  for (const cue of track.cues) {
    if (part.length && (part.length >= MAX_CUES_PER_PART || chars + cue.text.length > 20000)) {
      parts.push(part); part = []; chars = 0;
    }
    part.push(cue); chars += cue.text.length;
  }
  if (part.length) parts.push(part);
  return Promise.all(parts.map(async (cues, partIndex) => {
    const fields = { type: "youtube_subtitles" as const, videoId, capturedAt, transcriptId,
      language: track.language, generated: track.generated, partIndex, partCount: parts.length, cues };
    return { ...fields, recordId: `youtube:subtitles:${await sha256(JSON.stringify(fields))}` };
  }));
}
