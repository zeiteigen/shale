import { expect, test } from "bun:test";
import { chromium, type BrowserContext } from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const integration = process.env.SHALE_BROWSER_E2E === "1" ? test : test.skip;
const ID = "abcdefghijk";

function silence(seconds: number) {
  const bytes = seconds * 8000 * 2, buffer = Buffer.alloc(44 + bytes);
  buffer.write("RIFF"); buffer.writeUInt32LE(36 + bytes, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(bytes, 40); return buffer;
}
async function eventually(check: () => Promise<boolean>, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await check()) return; await Bun.sleep(100); }
  throw new Error("YouTube Chrome fixture timed out");
}

integration("unpacked YouTube module tracks real media, retrieves captions, and survives worker termination", async () => {
  const profile = await mkdtemp(join(tmpdir(), "shale-youtube-chrome-"));
  const extension = join(import.meta.dir, "../scripts/browser-chrome-extension");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath: process.env.SHALE_CHROMIUM_PATH || "/usr/bin/chromium",
      channel: "chromium", headless: true, args: ["--no-sandbox", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    await worker.evaluate(`chrome.storage.local.set({serverUrl:'http://127.0.0.1:9/ingest',modules:{browser:false,'ai-chats':false,'search-queries':false,youtube:true}})`);
    await context.route("https://www.youtube.com/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/audio.wav") return route.fulfill({ contentType: "audio/wav", body: silence(20) });
      if (path.startsWith("/youtubei/v1/get_transcript")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({
        transcriptRenderer: { transcriptFooterRenderer: { languageMenu: { sortFilterSubMenuRenderer: { subMenuItems: [{ title: "English", selected: true }] } } },
          content: { transcriptSegmentListRenderer: { initialSegments: [{ transcriptSegmentRenderer: { startMs: "0", endMs: "20000", snippet: { runs: [{ text: "Fixture transcript" }] } } }] } } },
      }) });
      if (path !== "/watch") return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ contentType: "text/html", body: `<html><body><ytd-watch-flexy video-id="${ID}"><div id="movie_player"><video class="html5-main-video" controls src="/audio.wav"></video></div></ytd-watch-flexy><script>
        const response={videoDetails:{videoId:'${ID}',title:'Real media fixture',author:'Fixture channel',lengthSeconds:'20',shortDescription:'Fixture description'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{languageCode:'en',name:{simpleText:'English'},baseUrl:'https://www.youtube.com/api/timedtext'}]}}};
        document.querySelector('#movie_player').getPlayerResponse=()=>response;
        window.ytcfg={get:()=>({client:{clientName:'WEB',clientVersion:'2'}})};
        document.querySelector('ytd-watch-flexy').data={engagementPanels:[{engagementPanelSectionListRenderer:{panelIdentifier:'engagement-panel-searchable-transcript',content:{continuationItemRenderer:{continuationEndpoint:{getTranscriptEndpoint:{params:'fixture'}}}}}}]};
      </script></body></html>` });
    });
    const control = await context.newPage(); await control.goto(worker.url().replace("background.js", "popup.html"));
    const page = await context.newPage(); await page.goto(`https://www.youtube.com/watch?v=${ID}`);
    await page.waitForFunction(() => document.querySelector("video")?.readyState === 4);
    await control.evaluate(`chrome.runtime.sendMessage({action:'youtube:capture_current'})`);
    const rows = () => control.evaluate<any[]>(`import(chrome.runtime.getURL('outbox.js')).then(m=>m.outboxItems())`);
    // A seek beyond halfway, followed by only a fraction of a second, is insufficient.
    await page.evaluate(async () => { const video = document.querySelector("video")!; video.currentTime = 12; await video.play(); });
    await page.waitForTimeout(350); await page.evaluate(() => document.querySelector("video")!.pause());
    expect((await rows()).some(row => row.record.type === "youtube_subtitles")).toBe(false);
    await page.evaluate(() => { const video = document.querySelector("video")!; video.currentTime = 0; video.playbackRate = 8; });
    await page.waitForTimeout(100);
    await page.evaluate(() => document.querySelector("video")!.play());
    await eventually(async () => (await rows()).some(row => row.record.type === "youtube_subtitles"));
    const captures = (await rows()).filter(row => row.record.type === "youtube_video");
    expect(captures.at(-1).record.metadata.title).toBe("Real media fixture");
    expect(Math.max(...captures.map(row => row.record.ranges.reduce((total: number, [start, end]: number[]) => total + end - start, 0)))).toBeGreaterThanOrEqual(10);
    const cdp = await context.browser()!.newBrowserCDPSession();
    const targets = await cdp.send("Target.getTargets");
    const target = targets.targetInfos.find(target => target.type === "service_worker" && target.url === worker.url());
    expect(target).toBeTruthy(); await cdp.send("Target.closeTarget", { targetId: target!.targetId }); await cdp.detach();
    await control.evaluate(`chrome.runtime.sendMessage({action:'get_status'})`);
    const progress = await control.evaluate<any>(`chrome.storage.local.get('module:youtube:video:abcdefghijk')`);
    expect(progress[`module:youtube:video:${ID}`].subtitleHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await rows()).some(row => row.record.type === "youtube_subtitles")).toBe(true);
  } finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
}, 45000);
