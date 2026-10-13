# YouTube

Captures standard YouTube videos played in Chrome through the shared Shale Browser Ingestor. No API key, separate account connection, video download, or history import is required.

## Capture

Opening a video installs playback tracking; a source is created once content actually plays. Metadata includes the title, full description, channel, canonical URL, duration, publication date, thumbnail, tags, category, and available view/like counts.

Subtitles are captured once **unique played portions cover at least 50%** of the video. Seeking ahead does not qualify, and replaying a portion counts once. Coverage accumulates across visits and browser restarts. Background and picture-in-picture playback count, at any playback speed. Ads, pauses, and buffering do not count.

Only desktop `youtube.com/watch` pages are supported. Shorts, embeds, YouTube Music, upcoming videos, active live streams, and incognito tabs are excluded. Completed recordings with a finite duration are eligible. Tracking starts when the module installs; it does not infer earlier playback from the current position. Snapshots persist every five seconds and on playback/navigation boundaries; an abrupt tab or browser termination can lose the last few seconds.

Prefer English creator captions, then English automatic captions, then captions in the video's original language. `preferredLanguages` changes the preferred language order. No automatic translation is requested. Transcripts come from the watching tab's read endpoints, independently of whether closed captions are displayed. Unavailable or blocked captions leave the metadata source usable; transient retrieval failures retry while the video is open. The popup's **Capture / retry current video** refreshes tracking and retries qualified transcripts without bypassing the threshold.

## Sources and summaries

Each video has one source: ID `youtube:<videoId>`, type `youtube_video`, origin `youtube`, and its canonical watch URL. Repeat visits update it. Video and channel entities are linked by `PUBLISHED_BY`.

Before subtitle enrichment, the summary describes the video and observed playback. After enrichment:

- **Summary:** an LLM overview of the complete transcript.
- **Derived snippets:** more detailed summaries of topic sections chosen by the LLM, with timestamps and video links.
- **Excerpt snippets:** description and metadata, including subtitle language and automatic/creator provenance.

The existing limits apply: 16 snippets, 1,200 characters per snippet, and 12,000 snippet characters total. Description and metadata reserve space before section summaries are allocated. Long transcripts are processed through bounded passes covering every cue. Intermediate results persist in SQLite, and progress updates reuse completed synthesis rather than calling the model again. Invalid model output is retried; failures preserve the previous source and remain pending for a later indexing run.

Raw metadata, played ranges, multipart captions, receipts, and summary checkpoints are extension-private SQLite tables. Scoped consumers see the indexed sources through Shale's normal access controls. Captions and capture messages contain no exported cookies, authorization headers, or signed caption URLs. Transcripts exceeding two million characters fail visibly instead of being silently truncated.

## Installation and operation

Run `bun run browser:build`, restart Shale so it discovers the extension, then reload the unpacked Chrome extension at `chrome://extensions`. The `youtube-index` cron runs every two minutes and on startup. It processes up to `maxVideosPerRun` videos per run, using Shale's configured chat model unless `llmModel` is set.

Settings are read fresh on every server operation. Browser capture policies refresh through the shared connector runtime; server admission checks current settings immediately. Disabling caption capture stops new caption admission and preserves existing source summaries.

The connector exposes `/connectors/youtube/policy`, `/status?ids=<jobIds>`, and `POST /retry`. Receipts distinguish durable admission from completed source indexing. Retry clears server processing errors; the browser popup retries page-side caption retrieval.

```bash
bun run settings list youtube
bun run settings set youtube preferredLanguages '["en", "fr"]'
bun run settings set youtube llmModel 'your-model'
bun test tests/youtube-*.test.ts
```
