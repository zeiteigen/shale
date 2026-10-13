import { getSDK, type ShaleSDK } from "@shale/sdk";
import { summaryBudget } from "./memory";
import { qualifies } from "./progress";
import { commitVideo, YOUTUBE_SOURCE_TYPE } from "./source";
import { cached, dueVideos, metadataOf, rangesOf, transcriptFor, videoFor, youtubeTables } from "./store";
import { settingsFor } from "./subscribe";
import { summarizeTranscript, type TranscriptSynthesis } from "./summarize";

export async function run(sdkOverride?: ShaleSDK, now = Date.now()) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir), settings = settingsFor(sdk);
  youtubeTables(sdk.database);
  const totals = { videos: 0, indexed: 0, errors: [] as string[] };
  if (!settings.enabled) return totals;
  const notify = async (result: ReturnType<typeof commitVideo>) => {
    try { await sdk.messages.publish("source:ingested", { sourceId: result.sourceId, type: YOUTUBE_SOURCE_TYPE,
      uri: result.uri, title: result.title, origin: "youtube", namespace: settings.namespace, chunksCount: result.chunksCount, timestamp: now }); }
    catch (error) { sdk.logger.warn("YouTube source committed but notification failed:", error); }
  };
  const rows = dueVideos(sdk.database, now, settings.maxVideosPerRun);
  totals.videos = rows.length;
  for (const row of rows) {
    try {
      const transcript = settings.captureSubtitles && qualifies(rangesOf(row), metadataOf(row).duration) ? transcriptFor(sdk.database, row.video_id) : null;
      const previous = cached<TranscriptSynthesis>(sdk.database, row.indexed_key);
      // Commit searchable metadata first, but keep the work dirty until enrichment completes.
      let result = commitVideo(sdk, row.video_id, settings.namespace, previous, !transcript);
      if (result.skipped) continue;
      await notify(result);
      if (transcript) {
        const synthesis = await summarizeTranscript(sdk, transcript, settings.llmModel, summaryBudget(metadataOf(row)));
        const current = videoFor(sdk.database, row.video_id)!, latest = transcriptFor(sdk.database, row.video_id);
        const currentSettings = settingsFor(sdk);
        if (latest?.transcript_id !== transcript.transcript_id || !currentSettings.enabled || !currentSettings.captureSubtitles) continue;
        // Description updates that alter the reserved budget are handled by the next pass.
        if (JSON.stringify(summaryBudget(metadataOf(current))) !== JSON.stringify(summaryBudget(metadataOf(row)))) continue;
        result = commitVideo(sdk, row.video_id, settings.namespace, synthesis);
        if (!result.skipped) await notify(result);
      }
      totals.indexed++;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      sdk.database.query("UPDATE youtube_videos SET dirty=1,retry_after=?,error=? WHERE video_id=?").run(now + 120_000, reason, row.video_id);
      totals.errors.push(`${row.video_id}: ${reason}`);
      sdk.logger.error("YouTube indexing failed:", error);
    }
  }
  return totals;
}
if (import.meta.main) run().catch(error => { console.error(error); process.exitCode = 1; });
export default run;
