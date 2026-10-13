import { videoAt, type VideoMetadata } from "../../contract";
import { currentPlayer } from "./player";

export default function readVideo(args: { videoId: string }): { metadata?: VideoMetadata; error?: string; unsupported?: boolean } {
  if (videoAt(location.href) !== args.videoId) return { error: "The tab moved to another video" };
  const response = currentPlayer(args.videoId), details = response?.videoDetails, micro = response?.microformat?.playerMicroformatRenderer;
  if (!details) return { error: "YouTube player metadata is not ready" };
  if (details.isLive || details.isUpcoming || micro?.liveBroadcastDetails?.isLiveNow)
    return { error: "Live and upcoming videos are excluded", unsupported: true };
  const duration = Number(details.lengthSeconds);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 172800) return { error: "Video duration is unavailable", unsupported: true };
  const count = (value: unknown) => { const n = Number(value); return value !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined; };
  const metadata: VideoMetadata = {
    title: String(details.title ?? "").slice(0, 1000), description: String(details.shortDescription ?? "").slice(0, 5000),
    channel: { name: String(details.author ?? micro?.ownerChannelName ?? "Unknown channel").slice(0, 500),
      ...(details.channelId ? { id: String(details.channelId), url: `https://www.youtube.com/channel/${details.channelId}` } : {}) }, duration,
    ...(micro?.publishDate || micro?.uploadDate ? { publishedAt: micro.publishDate ?? micro.uploadDate } : {}),
    ...(details.thumbnail?.thumbnails?.length ? { thumbnail: details.thumbnail.thumbnails.at(-1).url } : {}),
    ...(Array.isArray(details.keywords) ? { tags: details.keywords.slice(0, 100).map((tag: unknown) => String(tag).slice(0, 200)) } : {}),
    ...(micro?.category ? { category: String(micro.category).slice(0, 200) } : {}),
    ...(count(details.viewCount) !== undefined ? { viewCount: count(details.viewCount) } : {}),
  };
  // The public like count is optional; never capture the user's like/dislike state.
  const like = document.querySelector('like-button-view-model button[aria-label], #segmented-like-button button[aria-label]')?.getAttribute("aria-label");
  const exact = like?.match(/(?:along with|with)\s+([\d,]+)\s+other/i);
  if (exact) metadata.likeCount = Number(exact[1]!.replaceAll(",", ""));
  return metadata.title.trim() ? { metadata } : { error: "Video title is not ready" };
}
