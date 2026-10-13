import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import readVideo from "../extensions/youtube/chrome/inject/video";
import readSubtitles from "../extensions/youtube/chrome/inject/subtitles";

const VIDEO_A = "abcdefghijk";
const VIDEO_B = "lmnopqrstuv";
const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const globalKeys = ["document", "location", "ytInitialPlayerResponse", "ytInitialData", "ytcfg", "fetch"] as const;
const previousGlobals = new Map(globalKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

afterEach(() => {
  for (const key of globalKeys) {
    const descriptor = previousGlobals.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as any)[key];
  }
});

function setup(player: any, data: any = {}) {
  const { document } = parseHTML("<html><body><div id='movie_player'></div><ytd-watch-flexy></ytd-watch-flexy></body></html>");
  const moviePlayer = document.querySelector("#movie_player") as any;
  moviePlayer.getPlayerResponse = () => player;
  const flexy = document.querySelector("ytd-watch-flexy") as any;
  flexy.playerData = player;
  flexy.data = data;
  (globalThis as any).document = document;
  (globalThis as any).location = { href: watchUrl(VIDEO_A) };
  (globalThis as any).ytInitialPlayerResponse = { videoDetails: { videoId: VIDEO_B, title: "stale" } };
  (globalThis as any).ytInitialData = data;
  (globalThis as any).ytcfg = { get: (key: string) => key === "INNERTUBE_CONTEXT" ? { client: { clientName: "WEB", clientVersion: "2" } } : undefined };
}

const details = (videoId = VIDEO_A, extra: Record<string, unknown> = {}) => ({
  videoDetails: {
    videoId, title: "Current title", shortDescription: "Description", author: "Creator", channelId: "UC123",
    lengthSeconds: "125", viewCount: "9876", keywords: ["one", "two"],
    thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/low.jpg" }, { url: "https://i.ytimg.com/high.jpg" }] },
    ...extra,
  },
  microformat: { playerMicroformatRenderer: { publishDate: "2024-01-02", category: "Science", ownerChannelName: "Owner" } },
});

const track = (languageCode: string, name: string, baseUrl: string, kind?: string) => ({
  languageCode, name: { simpleText: name }, baseUrl, ...(kind ? { kind } : {}),
});
const transcriptPanel = (params: string) => ({ engagementPanels: [{ engagementPanelSectionListRenderer: {
  panelIdentifier: "engagement-panel-searchable-transcript",
  content: { continuationItemRenderer: { continuationEndpoint: { getTranscriptEndpoint: { params } } } },
} }] });

const transcriptData = (params: string, cues: Array<[number, number, string]>, menu?: any[]) => ({
  params,
  transcript: {
    segments: cues.map(([start, end, text]) => ({ transcriptSegmentRenderer: {
      startMs: String(start), endMs: String(end), snippet: { runs: [{ text }] },
    } })),
    transcriptFooterRenderer: { languageMenu: { sortFilterSubMenuRenderer: { subMenuItems: menu ?? [] } } },
  },
});

describe("YouTube page extraction", () => {
  test("uses current player identity, not stale initial data, and extracts metadata", () => {
    setup(details());
    const result = readVideo({ videoId: VIDEO_A });
    expect(result).toEqual({ metadata: {
      title: "Current title", description: "Description", channel: { name: "Creator", id: "UC123", url: "https://www.youtube.com/channel/UC123" },
      duration: 125, publishedAt: "2024-01-02", thumbnail: "https://i.ytimg.com/high.jpg", tags: ["one", "two"],
      category: "Science", viewCount: 9876,
    } });
    expect(readVideo({ videoId: VIDEO_B })).toEqual({ error: "The tab moved to another video" });
  });

  test("excludes live and upcoming videos, including live microformat state", () => {
    for (const flags of [{ isLive: true }, { isUpcoming: true }]) {
      setup(details(VIDEO_A, flags));
      expect(readVideo({ videoId: VIDEO_A })).toEqual({ error: "Live and upcoming videos are excluded", unsupported: true });
    }
    const live: any = details();
    live.microformat.playerMicroformatRenderer.liveBroadcastDetails = { isLiveNow: true };
    setup(live);
    expect(readVideo({ videoId: VIDEO_A }).unsupported).toBe(true);
  });

  test("prefers creator English, then falls back to the original caption language", async () => {
    const tracks = [
      track("en", "English (auto-generated)", "https://www.youtube.com/api/timedtext?v=x&lang=en", "asr"),
      track("en", "English", "https://www.youtube.com/api/timedtext?v=x&lang=en-creator"),
      track("ja", "Japanese", "https://www.youtube.com/api/timedtext?v=x&lang=ja"),
    ];
    const player = { ...details(), captions: { playerCaptionsTracklistRenderer: {
      captionTracks: tracks, audioTracks: [{ defaultCaptionTrackIndex: 2 }], defaultAudioTrackIndex: 0,
    } } };
    let request: any;
    setup(player, transcriptPanel("same"));
    (globalThis as any).fetch = async (url: any, init: any) => {
      request = { url: String(url), body: JSON.parse(init.body) };
      return Response.json(transcriptData("same", [[1000, 2100, "hello"]]));
    };
    expect(await readSubtitles({ videoId: VIDEO_A, languages: ["en"] })).toEqual({
      language: "en", generated: false, cues: [{ start: 1, end: 2.1, text: "hello" }],
    });
    expect(request.url).toContain("/youtubei/v1/get_transcript");
    expect(request.body.params).toBe("same");
    expect(request.body).toMatchObject({ externalVideoId: VIDEO_A, languageCode: "en" });

    // With no preferred track, the player-declared default caption track is used.
    (globalThis as any).fetch = async (_url: any, init: any) => Response.json(transcriptData(JSON.parse(init.body).params, [[0, 900, "original"]]));
    const original = await readSubtitles({ videoId: VIDEO_A, languages: [] });
    expect(original).toEqual({ language: "ja", generated: false, cues: [{ start: 0, end: 0.9, text: "original" }] });
  });

  test("switches transcript to the selected caption language and preserves cue timestamps", async () => {
    const tracks = [track("en", "English", "https://www.youtube.com/api/timedtext?lang=en"), track("fr", "French", "https://www.youtube.com/api/timedtext?lang=fr")];
    const player = { ...details(), captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } };
    setup(player, transcriptPanel("seed"));
    let call = 0;
    (globalThis as any).fetch = async (_url: any, init: any) => {
      const body = JSON.parse(init.body); call++;
      if (call === 1) return Response.json(transcriptData(body.params, [], [{ title: { simpleText: "English" }, selected: true }, {
        title: { simpleText: "French" }, continuation: { reloadContinuationData: { continuation: "french-cont" } },
      }]));
      expect(body.params).toBe("french-cont");
      return Response.json(transcriptData(body.params, [[2500, 3250, "bonjour"]]));
    };
    const result = await readSubtitles({ videoId: VIDEO_A, languages: ["fr"] });
    expect(call).toBe(2);
    expect(result).toEqual({ language: "fr", generated: false, cues: [{ start: 2.5, end: 3.25, text: "bonjour" }] });
  });

  test("uses timedtext json3 when transcript panel data is absent", async () => {
    const player = { ...details(), captions: { playerCaptionsTracklistRenderer: { captionTracks: [track("es", "Spanish", "https://www.youtube.com/api/timedtext?v=abc&lang=es")] } } };
    setup(player);
    let request: any;
    (globalThis as any).fetch = async (url: any, init: any) => {
      request = { url: String(url), credentials: init.credentials };
      return Response.json({ events: [{ tStartMs: 1500, dDurationMs: 800, segs: [{ utf8: "hola " }, { utf8: "mundo" }] }] });
    };
    expect(await readSubtitles({ videoId: VIDEO_A, languages: ["es"] })).toEqual({
      language: "es", generated: false, cues: [{ start: 1.5, end: 2.3, text: "hola mundo" }],
    });
    expect(new URL(request.url).searchParams.get("fmt")).toBe("json3");
    expect(request.credentials).toBe("include");
  });

  test("reports unavailable captions and refuses to return a transcript after navigation", async () => {
    setup(details());
    expect(await readSubtitles({ videoId: VIDEO_A, languages: ["en"] })).toEqual({ error: "This video has no available subtitles", unavailable: true });

    const player = { ...details(), captions: { playerCaptionsTracklistRenderer: { captionTracks: [track("en", "English", "https://www.youtube.com/api/timedtext?lang=en")] } } };
    setup(player);
    (globalThis as any).fetch = async (_url: any, init: any) => {
      (globalThis as any).location.href = watchUrl(VIDEO_B);
      return Response.json({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "must not leak" }] }] });
    };
    expect(await readSubtitles({ videoId: VIDEO_A, languages: ["en"] })).toEqual({ error: "The tab moved while subtitles were loading" });
  });

  test("falls back after a rejected transcript request and reports empty caption responses", async () => {
    const player = { ...details(), captions: { playerCaptionsTracklistRenderer: { captionTracks: [track("en", "English", "https://www.youtube.com/api/timedtext?lang=en")] } } };
    setup(player, transcriptPanel("seed"));
    (globalThis as any).fetch = async (url: any) => String(url).includes("get_transcript")
      ? Response.json({ error: "rejected" }, { status: 400 })
      : Response.json({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "fallback" }] }] });
    expect(await readSubtitles({ videoId: VIDEO_A, languages: ["en"] })).toMatchObject({ cues: [{ text: "fallback" }] });
    (globalThis as any).fetch = async () => new Response("");
    expect(await readSubtitles({ videoId: VIDEO_A, languages: ["en"] })).toMatchObject({ error: "YouTube returned an empty caption track; retry in the watching tab" });
  });
});
