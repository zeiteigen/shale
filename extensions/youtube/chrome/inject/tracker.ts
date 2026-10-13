import { videoAt } from "../../contract";
import { mergeRanges, qualifies, type PlayedRange } from "../../progress";

export interface TrackerArgs { tabId: number; videoId: string; sessionId: string; duration: number; stop?: boolean }
export interface Observation {
  tabId: number; videoId: string; sessionId: string; ranges: PlayedRange[]; firstWatchedAt: number; lastWatchedAt: number;
}
interface Tracker { videoId: string; sessionId: string; stop(): void; flush(): Promise<void> }

/** Runs in ISOLATED world. Page scripts cannot invoke the extension message API. */
export default function track(args: TrackerArgs) {
  const scope = globalThis as typeof globalThis & { __shaleYoutubeTracker?: Tracker };
  const previous = scope.__shaleYoutubeTracker;
  if (args.stop) { previous?.stop(); delete scope.__shaleYoutubeTracker; return { stopped: true }; }
  if (previous?.videoId === args.videoId && previous.sessionId === args.sessionId) { void previous.flush(); return { installed: true }; }
  previous?.stop();
  let ranges: PlayedRange[] = [], firstWatchedAt = 0, lastWatchedAt = 0, lastSent = 0, qualified = false;
  let video: HTMLVideoElement | null = null, ad = false, stopped = false, sending: Promise<void> | undefined;
  let baseline: { position: number; clock: number; rate: number; playing: boolean } | undefined;
  const player = () => document.querySelector("#movie_player");
  const isAd = () => !!player()?.classList.contains("ad-showing") || !!player()?.classList.contains("ad-interrupting");
  const sameVideo = () => videoAt(location.href) === args.videoId
    && (!document.querySelector("ytd-watch-flexy")?.getAttribute("video-id")
      || document.querySelector("ytd-watch-flexy")?.getAttribute("video-id") === args.videoId);

  function sample() {
    if (!video || stopped) return;
    const clock = performance.now(), position = video.currentTime;
    const content = sameVideo() && !isAd() && !video.seeking && Number.isFinite(position) && Number.isFinite(video.duration)
      && Math.abs(video.duration - args.duration) < Math.max(2, args.duration * .01);
    if (baseline?.playing && content) {
      const delta = position - baseline.position;
      const expected = (clock - baseline.clock) / 1000 * baseline.rate;
      // Seek events reset the baseline; this bound also rejects discontinuities/player switches.
      if (delta > 0 && delta <= expected + .75) {
        const merged = mergeRanges([...ranges, [baseline.position, position]], args.duration);
        if (merged.length > 2048) { baseline = undefined; stop(); return; }
        ranges = merged;
        const now = Date.now(); firstWatchedAt ||= now; lastWatchedAt = now;
      }
    }
    baseline = { position, clock, rate: video.playbackRate,
      playing: content && !video.paused && !video.ended && video.readyState >= 3 };
    if (ranges.length && (Date.now() - lastSent >= 5000 || (!qualified && qualifies(ranges, args.duration)))) void flush();
  }

  async function send() {
    if (!ranges.length) return;
    lastSent = Date.now(); qualified ||= qualifies(ranges, args.duration);
    const observation: Observation = { tabId: args.tabId, videoId: args.videoId, sessionId: args.sessionId,
      ranges: ranges.map(range => [...range]), firstWatchedAt, lastWatchedAt };
    try {
      const response = await chrome.runtime.sendMessage({ action: "youtube:observe", observation });
      if (response?.success) { lastSent = Date.now(); qualified = qualifies(observation.ranges, args.duration); }
      else if (response?.disabled || response?.error?.includes("capture is turned off")) stop();
    } catch { /* The next playback event/timer retries the cumulative snapshot. */ }
  }
  function flush() {
    return sending ??= send().finally(() => { sending = undefined; });
  }
  const ordinary = () => sample();
  const boundary = () => { sample(); void flush(); };
  const reset = () => { baseline = undefined; void flush(); };
  const events = ["timeupdate", "playing", "ratechange"];
  const boundaries = ["pause", "ended", "waiting"];
  const resets = ["seeking", "seeked", "emptied", "loadedmetadata"];
  function detach() {
    for (const event of events) video?.removeEventListener(event, ordinary);
    for (const event of boundaries) video?.removeEventListener(event, boundary);
    for (const event of resets) video?.removeEventListener(event, reset);
  }
  function attach() {
    if (stopped) return;
    const next = document.querySelector<HTMLVideoElement>("#movie_player video.html5-main-video, #movie_player video");
    if (next !== video) {
      detach(); video = next; baseline = undefined;
      for (const event of events) video?.addEventListener(event, ordinary);
      for (const event of boundaries) video?.addEventListener(event, boundary);
      for (const event of resets) video?.addEventListener(event, reset);
    }
    const nextAd = isAd();
    if (ad !== nextAd) { ad = nextAd; baseline = undefined; void flush(); }
    sample();
  }
  const observer = new MutationObserver(attach);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "video-id"] });
  const timer = setInterval(attach, 1000);
  function stop() {
    if (stopped) return;
    sample(); void flush(); stopped = true; detach(); observer.disconnect(); clearInterval(timer);
    window.removeEventListener("pagehide", stop);
    document.removeEventListener("yt-navigate-start", stop);
    if (scope.__shaleYoutubeTracker?.sessionId === args.sessionId) delete scope.__shaleYoutubeTracker;
  }
  scope.__shaleYoutubeTracker = { videoId: args.videoId, sessionId: args.sessionId, stop, flush };
  window.addEventListener("pagehide", stop);
  document.addEventListener("yt-navigate-start", stop);
  attach();
  return { installed: true };
}
