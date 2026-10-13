import { MAX_TRANSCRIPT_CHARACTERS, videoAt, type SubtitleCue, type SubtitleTrack } from "../../contract";
import { currentPlayer, watchData } from "./player";

/** Read-only requests from the watching page, using its current transcript continuation/context. */
export default async function readSubtitles(args: { videoId: string; languages: string[] }): Promise<SubtitleTrack | { error: string; unavailable?: boolean }> {
  if (videoAt(location.href) !== args.videoId) return { error: "The tab moved to another video" };
  const response = currentPlayer(args.videoId);
  if (!response) return { error: "Current player metadata is unavailable" };
  const tracks = response.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (!tracks.length) return { error: "This video has no available subtitles", unavailable: true };
  const original = response.captions?.playerCaptionsTracklistRenderer;
  const audio = original?.audioTracks?.[original.defaultAudioTrackIndex ?? 0];
  const native = tracks[audio?.defaultCaptionTrackIndex ?? audio?.captionTrackIndices?.[0]]?.languageCode
    ?? tracks.find((track: any) => track.kind === "asr")?.languageCode;
  const preferred = [...args.languages, ...(native ? [native] : [])];
  let track: any;
  for (const language of preferred) {
    const matches = tracks.filter((candidate: any) => candidate.languageCode === language || candidate.languageCode?.startsWith(`${language}-`));
    track = matches.find((candidate: any) => candidate.kind !== "asr") ?? matches[0];
    if (track) break;
  }
  track ??= tracks.find((candidate: any) => candidate.kind !== "asr") ?? tracks[0];
  const text = (value: any): string => typeof value === "string" ? value : value?.simpleText ?? value?.runs?.map((run: any) => run.text ?? "").join("") ?? "";
  const walk = (root: any, visit: (node: any) => void) => {
    const stack = [root], seen = new Set<object>();
    while (stack.length && seen.size < 100000) {
      const node = stack.pop();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node); visit(node);
      for (const value of Object.values(node)) if (value && typeof value === "object") stack.push(value);
    }
  };
  const fetchJson = async (params: string) => {
    const config = (globalThis as any).ytcfg;
    const context = config?.get?.("INNERTUBE_CONTEXT");
    if (!context) throw new Error("YouTube transcript context is unavailable");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json",
        "X-Youtube-Client-Name": String(config.get("INNERTUBE_CONTEXT_CLIENT_NAME") ?? 1),
        "X-Youtube-Client-Version": context.client.clientVersion,
        "X-Youtube-Bootstrap-Logged-In": String(!!config.get("LOGGED_IN")) };
      if (context.client.visitorData) headers["X-Goog-Visitor-Id"] = context.client.visitorData;
      const result = await fetch("/youtubei/v1/get_transcript?prettyPrint=false", { method: "POST", credentials: "include",
        headers, body: JSON.stringify({ context, params, languageCode: track.languageCode, externalVideoId: args.videoId }), signal: controller.signal });
      if (!result.ok) throw new Error(`YouTube transcript returned HTTP ${result.status}`);
      return await result.json();
    } finally { clearTimeout(timer); }
  };
  try {
    let params: string | undefined;
    for (const data of watchData()) {
      // Only the transcript panel's read endpoint is followed, never an arbitrary page command.
      walk(data, node => {
        if (node.panelIdentifier !== "engagement-panel-searchable-transcript") return;
        walk(node, nested => { if (nested.getTranscriptEndpoint?.params) params ??= nested.getTranscriptEndpoint.params; });
      });
      if (params) break;
    }
    let cues: SubtitleCue[] = [];
    if (params) try {
      let transcript = await fetchJson(params);
      const menus: any[] = [];
      walk(transcript, node => { if (node.transcriptFooterRenderer?.languageMenu?.sortFilterSubMenuRenderer?.subMenuItems)
        menus.push(...node.transcriptFooterRenderer.languageMenu.sortFilterSubMenuRenderer.subMenuItems); });
      // Language menu titles are localized; match the caption track's localized name first.
      const target = menus.find(item => text(item.title) === text(track.name));
      if (target && !target.selected) {
        const continuation = target.continuation?.reloadContinuationData?.continuation
          ?? target.continuation?.getTranscriptEndpoint?.params ?? target.serviceEndpoint?.getTranscriptEndpoint?.params;
        if (continuation) transcript = await fetchJson(continuation);
        else throw new Error("Selected subtitle language continuation is unavailable");
      } else if (menus.length && !target) throw new Error("Preferred subtitle track is absent from the transcript menu");
      walk(transcript, node => {
        const segment = node.transcriptSegmentRenderer;
        if (segment) cues.push({ start: Number(segment.startMs) / 1000, end: Number(segment.endMs) / 1000, text: text(segment.snippet).trim() });
      });
    } catch { /* Try the player's caption endpoint when the transcript service is unavailable. */ }
    // Some layouts omit the transcript panel. Use the current player's caption URL as a fallback.
    if (!cues.length) {
      const url = new URL(track.baseUrl);
      if (url.protocol !== "https:" || !["www.youtube.com", "youtube.com"].includes(url.hostname) || url.pathname !== "/api/timedtext")
        throw new Error("Invalid YouTube caption endpoint");
      url.searchParams.set("fmt", "json3");
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
      try {
        const result = await fetch(url, { credentials: "include", signal: controller.signal });
        if (!result.ok) throw new Error(`YouTube captions returned HTTP ${result.status}`);
        const body = await result.text();
        if (!body.trim()) throw new Error("YouTube returned an empty caption track; retry in the watching tab");
        let data: any;
        try { data = JSON.parse(body); } catch { throw new Error("YouTube returned unreadable captions; retry in the watching tab"); }
        cues = (data.events ?? []).filter((event: any) => event.segs?.length).map((event: any) => ({
          start: Number(event.tStartMs) / 1000, end: (Number(event.tStartMs) + Number(event.dDurationMs)) / 1000,
          text: event.segs.map((segment: any) => segment.utf8 ?? "").join("").trim(),
        }));
      } finally { clearTimeout(timer); }
    }
    if (videoAt(location.href) !== args.videoId) return { error: "The tab moved while subtitles were loading" };
    cues = cues.filter(cue => cue.text && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start)
      .sort((a, b) => a.start - b.start);
    if (!cues.length) throw new Error("YouTube returned an empty transcript");
    if (cues.some(cue => cue.text.length > 10000) || cues.reduce((n, cue) => n + cue.text.length, 0) > MAX_TRANSCRIPT_CHARACTERS)
      throw new Error("Transcript exceeds the supported size; it was not truncated");
    return { language: track.languageCode, generated: track.kind === "asr", cues };
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}
