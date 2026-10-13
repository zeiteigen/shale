import { YOUTUBE_PROTOCOL_VERSION, sha256, subtitleRecords, transcriptContent, validateYoutubeBatch, validateYoutubeRecord,
  videoAt, type SubtitleRecord, type SubtitleTrack, type VideoMetadata, type VideoRecord } from "../contract";
import { mergeRanges, playedSeconds, qualifies, type PlayedRange } from "../progress";
import type { Observation, TrackerArgs } from "./inject/tracker";
import type { ModuleDefinition, ModuleRuntime } from "./types";

interface TabState { videoId: string; sessionId: string; metadata: VideoMetadata }
interface VideoState {
  ranges: PlayedRange[]; firstWatchedAt: number; lastWatchedAt: number;
  pending?: VideoRecord; subtitleHash?: string; subtitleRetryAt?: number; unavailable?: boolean;
}
interface Status { videoId?: string; title?: string; watchedPercent?: number; subtitles?: string; error?: string; capturedAt?: number }
const TABS_KEY = "module:youtube:tabs";
const DEFAULT_POLICY = { enabled: true, captureSubtitles: true, preferredLanguages: ["en"] };

export default function register(runtime: ModuleRuntime): ModuleDefinition {
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work); queue = next.catch(error => runtime.log(error)); return next;
  };
  const policy = async () => ({ ...DEFAULT_POLICY, ...await runtime.policy() });
  const tabs = async (): Promise<Record<string, TabState>> => (await chrome.storage.session.get(TABS_KEY))[TABS_KEY] as Record<string, TabState> | undefined ?? {};
  const saveTabs = (value: Record<string, TabState>) => chrome.storage.session.set({ [TABS_KEY]: value });
  const stateFor = (id: string) => runtime.storage.get<VideoState>(`video:${id}`, { ranges: [], firstWatchedAt: 0, lastWatchedAt: 0 });
  const saveState = (id: string, value: VideoState) => runtime.storage.set(`video:${id}`, value);
  const setStatus = async (patch: Status) => {
    const previous = await runtime.storage.get<Status>("status", {});
    await runtime.storage.set("status", { ...(patch.videoId && patch.videoId !== previous.videoId ? {} : previous), ...patch });
  };
  const fetching = new Set<string>();

  async function drainWatch(id: string, state: VideoState) {
    if (state.pending) {
      if (!await runtime.hasRecord(state.pending.recordId)) await runtime.enqueue([state.pending]);
      delete state.pending; await saveState(id, state);
    }
  }
  async function drainSubtitles(id: string) { return serialize(async () => {
    const pending = await runtime.storage.get<SubtitleRecord[]>(`subtitles:${id}`, []);
    for (const record of pending) if (!await runtime.hasRecord(record.recordId)) await runtime.enqueue([record]);
    if (pending.length) {
      const state = await stateFor(id); state.subtitleHash = pending[0]!.transcriptId; state.subtitleRetryAt = 0;
      await saveState(id, state); await runtime.storage.set(`subtitles:${id}`, []);
    }
  }); }

  async function captureSubtitles(tabId: number, entry: TabState, force = false) {
    if (fetching.has(entry.videoId)) return;
    const config = await policy(), state = await stateFor(entry.videoId);
    if (!config.enabled || !config.captureSubtitles || !qualifies(state.ranges, entry.metadata.duration)
      || (!force && (state.subtitleHash || (state.subtitleRetryAt ?? 0) > Date.now()))) return;
    fetching.add(entry.videoId);
    try {
      await drainSubtitles(entry.videoId);
      if (!force && (await stateFor(entry.videoId)).subtitleHash) return;
      const track = await runtime.inject<SubtitleTrack | { error: string; unavailable?: boolean }>(tabId, "subtitles",
        { world: "MAIN", args: { videoId: entry.videoId, languages: config.preferredLanguages } });
      if (!track) throw new Error("The page returned no transcript");
      if ("error" in track) {
        await serialize(async () => {
          const current = await stateFor(entry.videoId); current.unavailable = !!track.unavailable;
          current.subtitleRetryAt = Date.now() + (track.unavailable ? 15 * 60000 : 120000); await saveState(entry.videoId, current);
        });
        await setStatus({ subtitles: track.unavailable ? "Unavailable" : "Retry pending", error: track.error });
        return;
      }
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab || tab.incognito || videoAt(tab.url ?? "") !== entry.videoId || !(await policy()).captureSubtitles) return;
      const hash = await sha256(transcriptContent(entry.videoId, track));
      if (force || hash !== (await stateFor(entry.videoId)).subtitleHash) {
        const records = await subtitleRecords(entry.videoId, track, Date.now());
        records.forEach(validateYoutubeRecord);
        // Persist the complete multipart plan before the first enqueue. A partial failure resumes it.
        await serialize(async () => {
          const pending = await runtime.storage.get<string[]>("pendingVideos", []);
          if (!pending.includes(entry.videoId)) await runtime.storage.set("pendingVideos", [...pending, entry.videoId]);
          await runtime.storage.set(`subtitles:${entry.videoId}`, records);
        });
        await drainSubtitles(entry.videoId);
      }
      await setStatus({ subtitles: `${track.language}${track.generated ? " (automatic)" : " (creator)"} queued`, error: "" });
    } catch (error) {
      await serialize(async () => {
        const current = await stateFor(entry.videoId); current.subtitleRetryAt = Date.now() + 120000; await saveState(entry.videoId, current);
      });
      await setStatus({ subtitles: "Retry pending", error: (error as Error).message });
    } finally { fetching.delete(entry.videoId); }
  }

  async function observe(observation: Observation) {
    if (!(await policy()).enabled) return { success: false, disabled: true };
    const entry = await serialize(async () => {
      const known = (await tabs())[observation.tabId];
      if (!known || known.videoId !== observation.videoId || known.sessionId !== observation.sessionId) return;
      const tab = await chrome.tabs.get(observation.tabId).catch(() => undefined);
      if (!tab || tab.incognito || videoAt(tab.url ?? "") !== known.videoId) return;
      const state = await stateFor(known.videoId);
      const capturedAt = Date.now();
      const fields = { type: "youtube_video" as const, videoId: known.videoId, capturedAt,
        firstWatchedAt: observation.firstWatchedAt, lastWatchedAt: observation.lastWatchedAt,
        metadata: known.metadata, ranges: observation.ranges };
      // Treat content-script messages as untrusted, just like wire captures.
      validateYoutubeRecord({ ...fields, recordId: "validation" });
      state.ranges = mergeRanges([...state.ranges, ...observation.ranges], known.metadata.duration);
      state.firstWatchedAt = state.firstWatchedAt ? Math.min(state.firstWatchedAt, observation.firstWatchedAt) : observation.firstWatchedAt;
      state.lastWatchedAt = Math.max(state.lastWatchedAt, observation.lastWatchedAt);
      const record = { ...fields, firstWatchedAt: state.firstWatchedAt, lastWatchedAt: state.lastWatchedAt, ranges: state.ranges };
      state.pending = { ...record, recordId: `youtube:video:${await sha256(JSON.stringify(record))}` };
      const pending = await runtime.storage.get<string[]>("pendingVideos", []);
      if (!pending.includes(known.videoId)) await runtime.storage.set("pendingVideos", [...pending, known.videoId]);
      await saveState(known.videoId, state);
      await drainWatch(known.videoId, state);
      await setStatus({ videoId: known.videoId, title: known.metadata.title, watchedPercent: 100 * playedSeconds(state.ranges, known.metadata.duration) / known.metadata.duration,
        capturedAt });
      return known;
    });
    if (!entry) return { success: false, disabled: true };
    await captureSubtitles(observation.tabId, entry);
    return { success: true };
  }

  async function install(tabId: number, force = false, attempt = 0) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined), videoId = videoAt(tab?.url ?? "");
    if (!tab || tab.incognito || !videoId) return;
    if (!(await policy()).enabled) return;
    const page = await runtime.inject<{ metadata?: VideoMetadata; error?: string; unsupported?: boolean }>(tabId, "video", { world: "MAIN", args: { videoId } });
    if (!page?.metadata) {
      if (page?.unsupported) await setStatus({ error: page.error });
      else if (attempt < 5) setTimeout(() => install(tabId, force, attempt + 1).catch(error => runtime.log(error)), 1000);
      return;
    }
    const current = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!current || current.incognito || videoAt(current.url ?? "") !== videoId) return;
    const entry = await serialize(async () => {
      const state = await tabs();
      const entry = { videoId, sessionId: state[tabId]?.videoId === videoId ? state[tabId]!.sessionId : crypto.randomUUID(), metadata: page.metadata! };
      state[tabId] = entry; await saveTabs(state); return entry;
    });
    await runtime.inject(tabId, "tracker", { args: { tabId, videoId, sessionId: entry.sessionId, duration: entry.metadata.duration } satisfies TrackerArgs });
    await captureSubtitles(tabId, entry, force);
  }

  async function wake() {
    const pending = await runtime.storage.get<string[]>("pendingVideos", []);
    for (const id of pending) {
      try { await serialize(async () => drainWatch(id, await stateFor(id))); await drainSubtitles(id); }
      catch (error) { runtime.log(error); }
    }
    await serialize(async () => {
      const latest = await runtime.storage.get<string[]>("pendingVideos", []);
      const remaining: string[] = [];
      // A capture for the same video can arrive during this sweep. Clear only work that is still drained.
      for (const id of latest) if ((await stateFor(id)).pending || (await runtime.storage.get<SubtitleRecord[]>(`subtitles:${id}`, [])).length)
        remaining.push(id);
      await runtime.storage.set("pendingVideos", remaining);
    });
    const open = await chrome.tabs.query({ url: ["https://www.youtube.com/watch*", "https://youtube.com/watch*"] });
    for (const tab of open) if (tab.id !== undefined && !tab.incognito) {
      try { await install(tab.id); } catch (error) { runtime.log(error); await setStatus({ error: (error as Error).message }); }
    }
    await runtime.deliver();
  }

  return {
    id: "youtube", label: "YouTube",
    protocol: { batchType: "youtube_batch", version: YOUTUBE_PROTOCOL_VERSION, validate: validateYoutubeBatch },
    claims: { match: url => !!videoAt(url) }, wake,
    status: () => runtime.storage.get<Status>("status", {}),
    listeners: {
      async navigation(details) {
        if (details.frameId !== 0) return;
        const videoId = videoAt(details.url);
        await serialize(async () => { const state = await tabs(); if (state[details.tabId]?.videoId !== videoId) delete state[details.tabId]; await saveTabs(state); });
        if (videoId) return install(details.tabId);
      },
      tabComplete: id => install(id), tabActivated: info => install(info.tabId), alarm: wake,
      tabRemoved: id => serialize(async () => { const state = await tabs(); delete state[id]; await saveTabs(state); }),
    },
    actions: {
      observe: request => observe(request.observation),
      async capture_current() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id === undefined || !videoAt(tab.url ?? "")) throw new Error("Open a standard YouTube video to capture it");
        if (tab.incognito) throw new Error("Private browsing is excluded");
        await install(tab.id, true);
        return { success: true, message: "Playback tracking refreshed. Subtitles require 50% unique playback." };
      },
    },
  };
}
