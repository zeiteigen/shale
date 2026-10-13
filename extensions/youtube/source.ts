import type { ShaleSDK } from "@shale/sdk";
import { SourceGraph } from "@shale/sdk/graph/source";
import { memoryChunks } from "../../lib/memory/prepare";
import { videoUrl } from "./contract";
import { videoMemory } from "./memory";
import { digest, metadataOf, videoFor } from "./store";
import type { TranscriptSynthesis } from "./summarize";

export const YOUTUBE_SOURCE_TYPE = "youtube_video";

/** Reload mutable metadata/progress inside the commit; model calls never hold a SQLite transaction. */
export function commitVideo(sdk: ShaleSDK, videoId: string, namespace: string, synthesis?: TranscriptSynthesis, clearDirty = true) {
  return sdk.database.transaction(() => {
    const row = videoFor(sdk.database, videoId)!;
    const metadata = metadataOf(row), memory = videoMemory(row, synthesis), uri = videoUrl(videoId);
    const result = sdk.ingest.sourceAndChunks({ namespace,
      source: { id: `youtube:${videoId}`, type: YOUTUBE_SOURCE_TYPE, origin: "youtube", uri, title: metadata.title,
        created_at: row.first_watched_at, updated_at: row.last_watched_at,
        hash: digest(JSON.stringify([row.metadata, row.ranges, row.first_watched_at, row.last_watched_at, synthesis?.key])),
        observation: { captureOrigin: "live-dom", quality: synthesis ? "full" : "metadata" } },
      chunks: memoryChunks(memory), memory });
    if (!result.skipped) {
      const graph = new SourceGraph(sdk.database, sdk.graph, result.sourceId, namespace, row.last_watched_at);
      const video = graph.entity(videoId, metadata.title, "YoutubeVideo");
      const channel = graph.entity(metadata.channel.id ?? metadata.channel.url ?? metadata.channel.name, metadata.channel.name, "YoutubeChannel");
      graph.claim(video, "SOURCE_URI", { value: uri });
      graph.claim(video, "DURATION_SECONDS", { value: metadata.duration });
      graph.link(video, "PUBLISHED_BY", channel);
      if (metadata.channel.url) graph.claim(channel, "CHANNEL_URL", { value: metadata.channel.url });
      if (metadata.publishedAt) graph.claim(video, "PUBLISHED_AT", { value: metadata.publishedAt });
    }
    sdk.database.query(`UPDATE youtube_videos SET source_id=?, indexed_version=?,indexed_transcript=?,indexed_key=?,
      excluded=?,dirty=?,error=NULL,retry_after=0 WHERE video_id=?`)
      .run(result.skipped ? null : result.sourceId, row.version, synthesis?.transcriptId ?? null, synthesis?.key ?? null,
        Number(!!result.skipped), Number(!clearDirty && !result.skipped), videoId);
    return { ...result, uri, title: metadata.title };
  })();
}
